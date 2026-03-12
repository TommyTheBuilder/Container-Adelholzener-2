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
- `ADMIN_ROLE` (optional): Rollenname, der als Admin gilt (Default: `container_admin`)

### Token-Format (`session` Query-Parameter)
Der Parameter `session` hat das Format:
`base64url(payload).base64url(hmac_sha256(payload, SHARED_AUTH_SECRET))`

Empfohlenes Payload-JSON:
```json
{
  "user": "max.mustermann",
  "roles": ["container_admin"],
  "exp": 1735689600
}
```

- `exp` ist ein Unix-Timestamp (Sekunden) und muss in der Zukunft liegen.
- Enthält `roles` nicht die `ADMIN_ROLE`, wird der Zugriff abgelehnt.

### Link vom Dashboard zur Container-Adminseite
Beispiel:
`https://container.paletten-ms.de/admin.html?session=<TOKEN>`

Alternativ funktioniert weiterhin `?key=ADMIN_KEY` für Legacy-Setups.
