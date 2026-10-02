/*
  NeuroSync – Rückensensor
  Board:   Seeed XIAO nRF52840 Sense  (Board-Paket "Seeed nRF52 Boards", NICHT "mbed-enabled")
  Library: "Seeed Arduino LSM6DS3" (Bibliotheksverwaltung)  – Adafruit Bluefruit kommt mit dem Board-Paket

  Der Sensor streamt Beschleunigung und Drehrate des IMU (LSM6DS3TR-C) per BLE.
  Die eigentliche Ganganalyse passiert in der App; die Firmware bleibt bewusst einfach.

  Protokoll (siehe README):
    Service  6e657572-6f73-796e-6300-000000000001
    Daten    ...0002  Notify, 62 Byte:  uint16 seq | 5 × { int16 ax,ay,az (mg), int16 gx,gy,gz (0.1 °/s) }  (little endian)
    Config   ...0003  Read,   6 Byte:   uint16 Abtastrate Hz | uint8 Beschleunigungsbereich g | uint8 Protokollversion | uint16 Firmware
    Batterie Standard Battery Service (0x180F)
*/

#include <bluefruit.h>
#include <Wire.h>
#include "LSM6DS3.h"

// ---- Einstellungen ----
static const uint16_t SAMPLE_RATE_HZ   = 52;  // Abtastrate Richtung App
static const uint8_t  SAMPLES_PER_PKT  = 5;
static const uint8_t  ACCEL_RANGE_G    = 4;
static const uint16_t FIRMWARE_VERSION = 1;
static const char*    DEVICE_NAME      = "NeuroSync-Back";

// UUIDs (Bluefruit erwartet die Bytes in umgekehrter Reihenfolge)
#define NS_UUID(last) { last,0x00,0x00,0x00,0x00,0x00,0x00,0x63,0x6e,0x79,0x73,0x6f,0x72,0x75,0x65,0x6e }
const uint8_t UUID_SERVICE[16] = NS_UUID(0x01);
const uint8_t UUID_DATA[16]    = NS_UUID(0x02);
const uint8_t UUID_CONFIG[16]  = NS_UUID(0x03);

LSM6DS3 imu(I2C_MODE, 0x6A);
BLEService        svc(UUID_SERVICE);
BLECharacteristic chData(UUID_DATA);
BLECharacteristic chConfig(UUID_CONFIG);
BLEBas            bas;

static int16_t  batch[SAMPLES_PER_PKT][6];
static uint8_t  inBatch = 0;
static uint16_t seq = 0;
static bool     streaming = false;
static uint32_t nextSampleUs = 0;
static uint32_t lastBatteryMs = 0;

static int16_t clamp16(float v) {
  if (v > 32767.f) return 32767;
  if (v < -32768.f) return -32768;
  return (int16_t)v;
}

// Batterie: XIAO nRF52840 misst VBAT über P0.14 (Freigabe) / P0.31. Werte ggf. am eigenen Board prüfen.
static uint8_t readBatteryPercent() {
#if defined(PIN_VBAT) && defined(VBAT_ENABLE)
  pinMode(VBAT_ENABLE, OUTPUT);
  digitalWrite(VBAT_ENABLE, LOW);
  analogReadResolution(12);
  analogReference(AR_INTERNAL_3_0);
  delay(5);
  float raw = analogRead(PIN_VBAT);
  digitalWrite(VBAT_ENABLE, HIGH);
  float volts = raw / 4095.f * 3.0f * 2.96f;  // Spannungsteiler 1M / 510k
  float pct = (volts - 3.3f) / (4.2f - 3.3f) * 100.f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (uint8_t)pct;
#else
  return 100;
#endif
}

static void onCccd(uint16_t connHdl, BLECharacteristic* chr, uint16_t cccdValue) {
  if (chr->uuid == chData.uuid) {
    streaming = chr->notifyEnabled(connHdl);
    inBatch = 0;
    nextSampleUs = micros();
  }
}

static void onConnect(uint16_t connHdl) {
  // Kurze Verbindungsintervalle für gleichmäßigen Datenfluss
  BLEConnection* c = Bluefruit.Connection(connHdl);
  c->requestConnectionParameter(12);  // 15 ms
#ifdef LED_BLUE
  digitalWrite(LED_BLUE, LOW);
#endif
}

static void onDisconnect(uint16_t connHdl, uint8_t reason) {
  streaming = false;
#ifdef LED_BLUE
  digitalWrite(LED_BLUE, HIGH);
#endif
}

static void startAdvertising() {
  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(svc);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(160, 320);  // 100–200 ms
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);
}

void setup() {
#ifdef LED_BLUE
  pinMode(LED_BLUE, OUTPUT);
  digitalWrite(LED_BLUE, HIGH);
#endif

  imu.settings.accelEnabled    = 1;
  imu.settings.accelRange      = ACCEL_RANGE_G;
  imu.settings.accelSampleRate = 104;
  imu.settings.gyroEnabled     = 1;
  imu.settings.gyroRange       = 1000;
  imu.settings.gyroSampleRate  = 104;
  imu.settings.tempEnabled     = 0;
  imu.begin();

  Bluefruit.configPrphConn(128, BLE_GAP_EVENT_LENGTH_DEFAULT, 16, 16);  // MTU ≥ 65 Byte nötig
  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName(DEVICE_NAME);
  Bluefruit.Periph.setConnectCallback(onConnect);
  Bluefruit.Periph.setDisconnectCallback(onDisconnect);

  bas.begin();
  bas.write(readBatteryPercent());

  svc.begin();

  chData.setProperties(CHR_PROPS_NOTIFY);
  chData.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chData.setMaxLen(2 + SAMPLES_PER_PKT * 12);
  chData.setCccdWriteCallback(onCccd);
  chData.begin();

  chConfig.setProperties(CHR_PROPS_READ);
  chConfig.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  chConfig.setFixedLen(6);
  chConfig.begin();
  uint8_t cfg[6] = { (uint8_t)(SAMPLE_RATE_HZ & 0xFF), (uint8_t)(SAMPLE_RATE_HZ >> 8), ACCEL_RANGE_G, 1,
                     (uint8_t)(FIRMWARE_VERSION & 0xFF), (uint8_t)(FIRMWARE_VERSION >> 8) };
  chConfig.write(cfg, sizeof(cfg));

  startAdvertising();
  nextSampleUs = micros();
}

void loop() {
  uint32_t nowMs = millis();
  if (nowMs - lastBatteryMs > 30000) {
    lastBatteryMs = nowMs;
    bas.notify(readBatteryPercent());
  }

  if (!streaming) {
    delay(20);  // spart Strom, solange niemand zuhört
    return;
  }

  const uint32_t periodUs = 1000000UL / SAMPLE_RATE_HZ;
  if ((int32_t)(micros() - nextSampleUs) < 0) return;
  nextSampleUs += periodUs;

  int16_t* s = batch[inBatch];
  s[0] = clamp16(imu.readFloatAccelX() * 1000.f);
  s[1] = clamp16(imu.readFloatAccelY() * 1000.f);
  s[2] = clamp16(imu.readFloatAccelZ() * 1000.f);
  s[3] = clamp16(imu.readFloatGyroX() * 10.f);
  s[4] = clamp16(imu.readFloatGyroY() * 10.f);
  s[5] = clamp16(imu.readFloatGyroZ() * 10.f);

  if (++inBatch == SAMPLES_PER_PKT) {
    inBatch = 0;
    uint8_t pkt[2 + SAMPLES_PER_PKT * 12];
    pkt[0] = seq & 0xFF;
    pkt[1] = seq >> 8;
    memcpy(pkt + 2, batch, sizeof(batch));  // nRF52 ist little endian
    seq++;
    chData.notify(pkt, sizeof(pkt));  // bei vollem Puffer geht das Paket verloren – die App erkennt das an seq
  }
}
