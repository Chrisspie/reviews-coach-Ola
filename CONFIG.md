# Statyczna konfiguracja rozszerzenia

Rozszerzenie nie wyswietla zadnych formularzy konfiguracyjnych. Backendowy adres proxy oraz link do abonamentu zapisujemy w lokalnym pliku JSON.

## Pliki

- `config.default.json` – wersja developerska (domyslnie wskazuje `http://localhost:3000`).
- `config.json` – docelowa konfiguracja na produkcje. Plik jest dodany do `.gitignore`, dlatego przed publikacja trzeba skopiowac `config.default.json` pod nowa nazwe i uzupelnic prawdziwe dane.

```json
{
  "proxyBase": "https://proxy.twojadomena.com",
  "upgradeUrl": "https://twojadomena.com/abonament",
  "devMockGoogleEmail": "tester@example.com"
}
```

Pole `devMockGoogleEmail` jest opcjonalne – jeżeli je ustawisz, rozszerzenie nie będzie wołało Google OAuth i zawsze wyśle wskazany e-mail do backendu (idealne do testów). Przed publikacją produkcyjną usuń tę wartość lub zostaw pusty string.

## Kroki przed wydaniem

1. Skopiuj `config.default.json` do `config.json` i ustaw docelowy `proxyBase` (HTTPS) oraz opcjonalnie `upgradeUrl`.
2. W Google Cloud utworz OAuth Client ID typu *Chrome App* i wklej jego wartosc do `manifest.json` -> `oauth2.client_id`.
3. Upewnij sie, ze w `manifest.json` wpisany jest zakres `https://www.googleapis.com/auth/userinfo.email` (dodano go domyslnie).
4. Na backendzie ustaw zmienna `GOOGLE_CLIENT_ID` z ta sama wartoscia, aby proxy moglo weryfikowac tokeny.
5. Odswiez rozszerzenie (lub zbuduj CRX). Przy pierwszym uzyciu rozszerzenie poprosi uzytkownika o autoryzacje konta Google (`chrome.identity`).

Dzieki temu uzytkownik po instalacji tylko klika "Polacz z Google", a backend rozpoznaje go po koncie Google – bez wpisywania recznych kluczy licencyjnych.
