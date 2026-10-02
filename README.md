# NeuroSync – Gangverlauf bei MS

Schulprojekt: ein Rückensensor (**Seeed XIAO nRF52840 Sense**) misst den Gang, eine App (Web-App/PWA, Web Bluetooth) wertet ihn aus und zeigt den **Verlauf über Wochen und Monate**.

```
firmware/neurosync_tracker/   Arduino-Firmware für den XIAO (IMU → BLE)
app/                          Web-App (HTML/JS, keine Build-Tools, offline-fähig)
test/                         Tests der Ganganalyse (node --test)
```

## Was gemessen wird

Sensor am unteren Rücken (L3–L5, mittig, Gurt). Aus der Beschleunigung berechnet die App:

| Kennzahl | Bedeutung |
|---|---|
| Gehtempo (m/s) | Schrittlänge × Kadenz – wichtigster Einzelwert |
| Kadenz, Schritte | Schritte pro Minute / Anzahl |
| Schrittlänge (m) | Modell des umgekehrten Pendels (Zijlstra & Hof) aus der vertikalen Schwerpunktbewegung; mit Beinlänge und Kalibrierfaktor |
| Schritt-Variabilität (%) | Variationskoeffizient der Schrittdauer |
| Asymmetrie (%) | Unterschied der Schrittdauer gerade/ungerade Schritte (links/rechts) |
| Regelmäßigkeit, Symmetrie-Index | Autokorrelation der Vertikalbeschleunigung (Moe-Nilssen) |
| Rumpfschwankung (g) | RMS der horizontalen Beschleunigung |
| Tempo-Ermüdung (%) | Tempo im letzten vs. ersten Viertel einer Messung |

Der Sensor darf beliebig geneigt sitzen: die Schwerkraftrichtung wird laufend geschätzt. Die **Baseline** ist der Median der ersten 5 Messungen; die Kacheln zeigen die Veränderung der letzten 3 Messungen dazu (ab ±5 % farbig). Zusätzlich: 2-Minuten-Gehtest, Fatigue-Selbsteinschätzung (1–5), Notizen, CSV/JSON-Export.

**Zweiter Sensor (Handgelenk, Herzfrequenz):** wird nicht gebaut, ist aber vorbereitet – jeder BLE-Pulssensor mit Standarddienst 0x180D lässt sich unter *Einstellungen* verbinden; der Durchschnittspuls wird je Messung gespeichert.

> Kein Medizinprodukt. Die Werte sind Schätzungen für ein Schulprojekt und ersetzen keine ärztliche Beurteilung.

## Firmware aufspielen

1. Arduino IDE → Boardverwalter-URL `https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json` → **„Seeed nRF52 Boards“** installieren (nicht die „mbed-enabled“-Variante).
2. Bibliothek **„Seeed Arduino LSM6DS3“** installieren.
3. Board „Seeed XIAO nRF52840 Sense“ wählen, `firmware/neurosync_tracker/neurosync_tracker.ino` öffnen, hochladen.
4. Der Sensor wirbt als **`NeuroSync-Back`** und streamt, sobald die App verbunden ist (blaue LED an).

> Die Firmware konnte in dieser Entwicklungsumgebung nicht auf echter Hardware getestet werden. Falls etwas nicht kompiliert (IMU-Klasse/Pins je nach Board-Paketversion) oder die Batterieanzeige falsch ist (`readBatteryPercent`), sind das die ersten Stellen zum Anpassen.

### BLE-Protokoll
Service `6e657572-6f73-796e-6300-000000000001`
- **Daten** `…0002` (Notify, 62 Byte): `uint16 seq` + 5 × (`int16 ax,ay,az` in mg, `int16 gx,gy,gz` in 0,1 °/s), little endian, 52 Hz → ~10 Pakete/s. Lücken in `seq` erkennt die App und gleicht sie aus.
- **Config** `…0003` (Read): `uint16 Abtastrate`, `uint8 Bereich (g)`, `uint8 Protokollversion`, `uint16 Firmware`.
- Batterie: Standarddienst 0x180F.

## App starten

Web Bluetooth braucht **HTTPS oder localhost** und **Chrome/Edge** (Android, Desktop). iPhone/Safari unterstützt es nicht (Alternative: Browser „Bluefy“).

- Lokal: `npm run serve` → http://localhost:8080
- Aufs Handy: Ordner `app/` auf **GitHub Pages** (oder einen anderen HTTPS-Host) legen und die URL in Chrome öffnen → „Zum Startbildschirm hinzufügen“.
- **Ohne Hardware:** Einstellungen → „Demo-Sensor“ (simulierter Gang) und „Demo-Verlauf laden“ (4 Monate Beispieldaten) – ideal für die Präsentation.

## Kalibrierung
Absolute Schrittlängen hängen von Beinlänge und Körperbau ab. Einmalig: Messungsart *Kalibrierung* wählen, eine abgemessene Strecke (z. B. 20 m) gehen, echte Länge eingeben → Faktor wird gesetzt. Für den Verlauf sind auch unkalibrierte Werte aussagekräftig, solange der Sensor immer gleich sitzt.

## Tests
`npm test` – prüft mit synthetischen Gehsignalen u. a. Kadenz, Schrittlänge, Neigungsunabhängigkeit, Asymmetrie, Variabilität, Ermüdung und die Paketdekodierung.
