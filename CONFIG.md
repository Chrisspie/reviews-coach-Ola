# Statyczna konfiguracja rozszerzenia

Rozszerzenie nie wyswietla zadnych formularzy konfiguracyjnych. Wartosci potrzebne do komunikacji z bezpiecznym backendem zapisujemy lokalnie w pliku JSON.

## Pliki

- `config.default.json` – wersja developerska (domyslnie wskazuje `http://localhost:3000` oraz klucz `DEV-LICENSE-PLACEHOLDER`).
- `config.json` – docelowa konfiguracja na produkcje. Plik jest dodany do `.gitignore`, dlatego przed publikacja trzeba skopiowac `config.default.json` pod nowa nazwe i uzupelnic prawdziwe dane.

```json
{
  "proxyBase": "https://proxy.twojadomena.com",
  "licenseKey": "PROD-LICENSE-XXXX",
  "upgradeUrl": "https://twojadomena.com/abonament"
}
```

## Kroki przed wydaniem

1. Skopiuj `config.default.json` do `config.json`.
2. Ustaw docelowy adres HTTPS serwera proxy (`proxyBase`).
3. Wygeneruj unikalny `licenseKey` i dopisz go na backendzie do zmiennej `LICENSE_KEYS`.
4. Opcjonalnie ustaw `upgradeUrl` – link do strony zakupu abonamentu, pokazywany uzytkownikowi po wyczerpaniu darmowego limitu.
5. Odswiez rozszerzenie (lub zbuduj CRX) - service worker odczyta `config.json` i automatycznie pobierze token sesyjny z `/api/extension/session` zaraz po starcie.

Dzieki temu uzytkownik po instalacji natychmiast ma dostep do gotowego narzedzia, a klucz Gemini pozostaje zawsze na backendzie.
