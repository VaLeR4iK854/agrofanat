# Агрофанат

Дневник домашней нано-фермы. Гидропоника, капельный полив, эксперименты, расчёты.

## Структура

```
.
├── app/                       Astro лендинг
└── .github/workflows/         деплой на GitHub Pages
```

## Стек

- Astro 6
- Tailwind 4
- Node 22

## Локальный запуск

```
cd app
npm install
npm run dev
```

## Деплой

Любой пуш в `main` запускает `.github/workflows/deploy.yml` - билд `app/` и публикация на GitHub Pages по адресу `agrofanat.ru` (через `app/public/CNAME`).
