# Statyczna konfiguracja rozszerzenia

Rozszerzenie nie wyswietla zadnych formularzy konfiguracyjnych. Backendowy adres proxy oraz link do abonamentu zapisujemy w lokalnym pliku JSON.

## Pliki

- `main.config.default.json` – wersja developerska (domyslnie wskazuje `http://localhost:3000`).
- `main.config.json` – docelowa konfiguracja na produkcje. Plik jest dodany do `.gitignore`, dlatego przed publikacja trzeba skopiowac `main.config.default.json` pod nowa nazwe i uzupelnic prawdziwe dane.

```json
{
  "proxyBase": "https://proxy.twojadomena.com",
  "upgradeUrl": "https://twojadomena.com/abonament",
  "licenseKey": "YOUR-LICENSE-KEY"
}
```

Pole `licenseKey` jest opcjonalne. Jeśli je ustawisz, rozszerzenie wyśle `licenseKey` do `/api/extension/session` i pominie logowanie magic link.

## Kroki przed wydaniem

1. Skopiuj `main.config.default.json` do `main.config.json` i ustaw docelowy `proxyBase` (HTTPS) oraz opcjonalnie `upgradeUrl`.
2. Ustaw backend do obslugi magic link i wysylki e-maili.
3. Odswiez rozszerzenie (lub zbuduj CRX). Przy pierwszym uzyciu uzytkownik podaje e-mail w zakladce Opcje i potwierdza logowanie linkiem z maila.
