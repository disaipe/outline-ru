# outline-ru

Русская локализация [Outline](https://github.com/outline/outline) без форка ядра.

Репозиторий содержит только перевод `ru_RU/translation.json`, два git-патча на `shared/i18n/index.ts` и `shared/utils/date.ts` (+3 строки к ядру), собственный `Dockerfile` и CI-автоматизацию. Исходный код Outline не хранится — он клонируется из upstream на зафиксированный коммит (`UPSTREAM_SHA`) при каждой сборке, поверх накладываются патчи, собирается Docker-образ и публикуется в GHCR.

Синхронизация с upstream — еженедельный GitHub Action: тянет свежий коммит, переводит новые ключи через OpenAI или Anthropic API, открывает PR на ревью.

## Запуск в docker-compose

`docker-compose.yml`:

```yaml
services:
  outline:
    image: ghcr.io/disaipe/outline-ru:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      - postgres
      - redis
    volumes:
      - outline-data:/var/lib/outline/data

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: outline
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: outline
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7
    restart: unless-stopped

volumes:
  outline-data:
  postgres-data:
```

`.env` (минимальный набор — полный список переменных см. в `.env.sample` upstream Outline):

```bash
# Язык интерфейса по умолчанию для новых пользователей
DEFAULT_LANGUAGE=ru_RU

# Публичный URL, через который пользователи открывают Outline
URL=https://wiki.example.com

# Секреты — сгенерируйте через `openssl rand -hex 32`
SECRET_KEY=<64 hex символа>
UTILS_SECRET=<64 hex символа>

# Подключения
POSTGRES_PASSWORD=<пароль БД>
DATABASE_URL=postgres://outline:${POSTGRES_PASSWORD}@postgres:5432/outline
REDIS_URL=redis://redis:6379

# SMTP, S3, OIDC/Google/Slack и т.д. — по необходимости
```

Запуск: `docker compose up -d`. Обновление до свежего образа: `docker compose pull && docker compose up -d`.
