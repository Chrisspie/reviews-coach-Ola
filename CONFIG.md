# Konfiguracja rozszerzenia

Rozszerzenie korzysta z generatora konfiguracji. Nie edytujesz juz recznie `config.json` ani `manifest.json` w katalogu rozszerzenia. Zamiast tego ustawiasz wartosci w plikach `.env`, a build tworzy gotowy pakiet w `dist/`.

## Pliki `.env`

- `.env.extension.local` - konfiguracja lokalna
- `.env.extension.prod` - konfiguracja produkcyjna
- `.env.extension.example` - szablon dla nowych srodowisk

Obslugiwane zmienne:

```dotenv
EXTENSION_PROXY_BASE=https://proxy.twojadomena.com
EXTENSION_UPGRADE_URL=https://twojadomena.com/#plany
EXTENSION_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
EXTENSION_LICENSE_KEY=
```

Pole `EXTENSION_LICENSE_KEY` jest opcjonalne. Jesli je ustawisz, rozszerzenie wysle `licenseKey` do `/api/extension/session` i pominie logowanie magic link.

## Build

1. Ustaw wartosci w odpowiednim pliku `.env.extension.*`.
2. Uruchom `npm run build:extension:local` albo `npm run build:extension:prod`.
3. Zaladuj rozszerzenie z katalogu `dist/local` albo `dist/prod`.

Build generuje:

- `config.json` z `proxyBase`, `upgradeUrl`, `licenseKey` i `googleClientId`
- `manifest.json` z poprawnym `host_permissions` dla backendu
