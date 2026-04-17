# outline-ru

Русская локализация [Outline](https://github.com/outline/outline) без форка ядра.

Репозиторий содержит только перевод `ru_RU/translation.json`, два git-патча на `shared/i18n/index.ts` и `shared/utils/date.ts` (+3 строки к ядру), собственный `Dockerfile` и CI-автоматизацию. Исходный код Outline не хранится — он клонируется из upstream на зафиксированный коммит (`UPSTREAM_SHA`) при каждой сборке, поверх накладываются патчи, собирается Docker-образ и публикуется в GHCR.

Синхронизация с upstream — еженедельный GitHub Action: тянет свежий коммит, переводит новые ключи через OpenAI или Anthropic API, открывает PR на ревью.
