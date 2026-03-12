# Container-Anmeldung

## Server-Konfiguration
Die Anwendung ist für folgende Defaults vorbereitet:

- **Domain**: `container.paletten-ms.de`
- **Port**: `3004`
- **PostgreSQL Datenbank**: `containeranmeldung`

## 1) PostgreSQL vorbereiten
```sql
CREATE DATABASE containeranmeldung;
```

## 2) Umgebungsvariablen setzen
```bash
cp .env.example .env
```

Danach **mindestens** die Zugangsdaten korrekt setzen:
- `DATABASE_URL` **oder**
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`

Vorgabe für deinen Server:
- DB: `containeranmeldung`
- User: `containera`
- Passwort: `containera`

> Wenn im Log `auth_failed` erscheint, sind Benutzer/Passwort oder Host nicht korrekt.

## 3) Starten
```bash
npm install
npm start
```

Der Server läuft danach auf `http://127.0.0.1:3004`.

## 4) Reverse-Proxy (Nginx Beispiel)
```nginx
server {
    server_name container.paletten-ms.de;

    location / {
        proxy_pass http://127.0.0.1:3004;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Danach Zertifikat z. B. mit Certbot einrichten.

## SSO-Übergabe von `test.paletten-ms.de`
Wenn der Admin-Login auf `test.paletten-ms.de/login.html` erfolgt und anschließend nach
`.../dashboard.html` weitergeleitet wird, kann diese App die Benutzerdaten/Rechte per
signiertem Session-Token übernehmen.

### Serverseite konfigurieren
- `SHARED_AUTH_SECRET`: gemeinsames Secret zwischen Dashboard und Container-App
- `ADMIN_ROLE` (optional): Rollenname, der als Admin gilt (Default: `ContainerAnmeldung`)

### Token-Format (`session` Query-Parameter)
Der Parameter `session` hat das Format:
`base64url(payload).base64url(hmac_sha256(payload, SHARED_AUTH_SECRET))`

Empfohlenes Payload-JSON:
```json
{
  "user": "max.mustermann",
  "roles": ["ContainerAnmeldung"],
  "exp": 1735689600
}
```

- `exp` ist ein Unix-Timestamp (Sekunden) und muss in der Zukunft liegen.
- Enthält `roles` nicht die `ADMIN_ROLE`, wird der Zugriff abgelehnt.


### Berechtigung im Login-/Dashboard-Projekt anlegen
Lege im zentralen Login-/Rechtesystem die Berechtigung **`ContainerAnmeldung`** an und ordne sie
den Benutzern/Gruppen zu, die Zugriff auf `admin.html` erhalten sollen.

Nur wenn das Session-Token die Rolle `ContainerAnmeldung` enthält, wird der Zugriff erlaubt.

### Link vom Dashboard zur Container-Adminseite
Beispiel:
`https://container.paletten-ms.de/admin.html?session=<TOKEN>`

Alternativ funktioniert weiterhin `?key=ADMIN_KEY` für Legacy-Setups.


### Codex-Befehl für das andere Projekt
Nutze im Login-/Dashboard-Projekt diesen Prompt für Codex (1:1 kopieren):

```text
Bitte implementiere eine SSO-Weitergabe zur Container-App mit signiertem Session-Token.

Ziel:
- Beim Login auf test.paletten-ms.de/login.html und Weiterleitung auf dashboard.html soll beim Link zur Container-Adminseite ein `session` Query-Parameter erzeugt werden.
- Die Container-App akzeptiert nur Benutzer mit der Berechtigung `ContainerAnmeldung`.

Anforderungen:
1) Lege (falls noch nicht vorhanden) die Berechtigung `ContainerAnmeldung` im Rechtesystem an und weise sie den berechtigten Nutzern/Gruppen zu.
2) Erzeuge ein JSON-Payload mit:
   - `user`: Benutzername
   - `roles`: Array aller Rechte/Rollen
   - `exp`: aktueller Unix-Zeitstempel + 300 Sekunden
3) Signiere `base64url(payload)` per HMAC-SHA256 mit dem Shared Secret (gleich wie `SHARED_AUTH_SECRET` der Container-App).
4) Tokenformat: `base64url(payload).base64url(signature)`
5) Verlinke auf:
   `https://container.paletten-ms.de/admin.html?session=<TOKEN>`
6) Achte darauf, dass `roles` den Eintrag `ContainerAnmeldung` enthält; sonst keinen Admin-Link anzeigen.

Bitte liefere den finalen Code inkl. kurzer Security-Hinweise (TTL, Secret-Handling, kein Logging des Tokens).
```
