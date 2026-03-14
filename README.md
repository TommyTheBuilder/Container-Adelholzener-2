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

## Login & Session-Cookie

- Login-Seite: `GET /login.html`
- Login-API: `POST /api/login`
- Logout-API: `POST /api/logout`

`/api/login` prüft Benutzername/Passwort gegen die Benutzerdatenbank (`ADMIN_AUTH_DATABASE_URL`) und setzt danach ein signiertes Session-Cookie (`SESSION_COOKIE_NAME`, Default `session`).

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

## SSO aus Portal: robuste Redirect-Strategie

### Root Cause
In einigen Browsern/Umgebungen wurden Session-Cookies bei Cross-Site-Navigation nicht zuverlässig mitgesendet (insbesondere bei restriktiver Cookie-Policy). Dadurch schlug die Auth-Auflösung in Zielsystemen bei rein Cookie-basierten Redirects fehl.

### Neue robuste Lösung
- SSO-Endpunkte liefern jetzt **kurzlebige serverseitig signierte Redirect-Tokens** (`ssoToken`) in der Redirect-URL.
- Auth-Auflösung am SSO-Endpunkt unterstützt **Session-Cookie und Bearer-Fallback**.
- Einheitliche Response-Felder: `url`, `ssoToken`, `token`, `session`, `expiresInSeconds`, `authSource`, `tokenType`.
- Strukturierte Logs ohne Secrets mit klarer Kennzeichnung der Auth-Quelle (`session_cookie` oder `bearer`).
- Konsistent für beide Ziele:
  - `GET /api/sso/container-session` (Container Anmeldung)
  - `GET /api/sso/container-planning` (Container Planung)

### HTTP-Fehlercodes
- `401`: nicht authentifiziert (`UNAUTHENTICATED`)
- `403`: keine Berechtigung (`FORBIDDEN`)
- `500`: Konfigurations-/Serverfehler (`CONFIG_ERROR` / `SERVER_ERROR`)

Alle Fehler kommen als JSON:
```json
{
  "ok": false,
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Bitte erneut am Portal anmelden."
  }
}
```

### Cookie-Konfiguration (Portal)
Für Cross-Site-Szenarien:
- `SameSite=None`
- `Secure`
- Domain nur gültig für die echte Parent-Domain (z. B. `.paletten-ms.de`), keine ungültigen Domain-Scopes
- Klare Trennung:
  - Portal-Auth-Cookie (Portal-intern)
  - Externe SSO-Session-Cookies/Redirect-Tokens (zielsystembezogen)

### Benötigte ENV-Variablen für SSO
- `SHARED_AUTH_SECRET` (Validierung von Session/Bearer-Token aus Portal)
- `SSO_TOKEN_SECRET` (Signatur der Redirect-Tokens; Fallback auf `SHARED_AUTH_SECRET`)
- `SSO_TOKEN_TTL_SECONDS` (Default `120`)
- `SSO_TOKEN_PARAM_NAME` (Default `ssoToken`)
- `SSO_CONTAINER_LOGIN_URL` (Default `${BASE_URL}/driver.html`)
- `SSO_CONTAINER_PLANNING_URL` (Default `${BASE_URL}/admin.html`)
- `SSO_CONTAINER_LOGIN_PERMISSION_KEY` (Default `integration.container_login`)
- `SSO_CONTAINER_PLANNING_PERMISSION_KEY` (Default `integration.container_planning`)

Zusätzlich für Berechtigungsprüfung:
- `ADMIN_PERMISSION_KEY` (Default `integrations.container_registration`)
- `ADMIN_AUTH_DATABASE_URL` (Default `postgresql://adminauth:adminauth11@db-host:5432/admin_auth`)
- `ADMIN_AUTH_QUERY`

## Beispiel-Checks (cURL)

### 1) Container Anmeldung (Cookie-basiert)
```bash
curl -i \
  -H 'Cookie: session=<SIGNED_PORTAL_SESSION_TOKEN>' \
  https://container.paletten-ms.de/api/sso/container-session
```

### 2) Container Planung (Bearer-Fallback)
```bash
curl -i \
  -H 'Authorization: Bearer <SIGNED_PORTAL_SESSION_TOKEN>' \
  https://container.paletten-ms.de/api/sso/container-planning
```

### 3) Ohne Auth (erwartet 401)
```bash
curl -i https://container.paletten-ms.de/api/sso/container-session
```

### 4) Falsche Berechtigung (erwartet 403)
```bash
curl -i \
  -H 'Cookie: session=<TOKEN_OHNE_PERMISSION>' \
  https://container.paletten-ms.de/api/sso/container-planning
```
