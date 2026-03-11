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

Passe danach `DATABASE_URL` (Passwort/Host) und `ADMIN_KEY` an.

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
