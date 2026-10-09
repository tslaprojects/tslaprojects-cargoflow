# UI/UX аудит и редизайн CargoFlow — план

Инструмент: skill **UI/UX Pro Max** (`.claude/skills/ui-ux-pro-max`, установлен из
[nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill), MIT).
Скрипты — Python 3 (стандартная библиотека), работают офлайн, данные — локальные CSV.

## Текущее состояние UI (исходные данные для аудита)

| Что                | Где                         | Факт                                                                                                                                                                                                       |
| ------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Стек               | `package.json`              | Next.js 16 (App Router), React 19, Tailwind 4, radix-ui, lucide-react, MapLibre                                                                                                                            |
| Токены             | `src/app/globals.css`       | ~79 CSS-переменных, `@theme inline`; `tabular-nums` для цифр                                                                                                                                               |
| Шрифт              | `globals.css` `--font-sans` | заявлен **Inter**, но не подключён (нет `next/font` / `@font-face`) — фактически системный шрифт                                                                                                           |
| Тёмная тема        | `globals.css`               | **нет** (ни `.dark`, ни `prefers-color-scheme`)                                                                                                                                                            |
| Базовые компоненты | `src/components/ui/*`       | 16 shadcn-подобных: button, input, dialog, sheet, table, tabs, badge, card…                                                                                                                                |
| Общие компоненты   | `src/components/common/*`   | DataTable, FilterBar, StatusBadge (реестр `STATUS_STYLES`), UrlTabs, ConfirmDialog, Field, Pagination, RouteTimeline                                                                                       |
| Каркас             | `src/components/layout/*`   | AppShell (сайдбар + мобильное нижнее меню, 4 основных пункта), поиск, уведомления, переключатель компании                                                                                                  |
| Локаль             | `src/lib/i18n`              | только ru-RU; длинные русские подписи — учитывать ширину кнопок/колонок                                                                                                                                    |
| Экраны             | `src/app/**/page.tsx`       | 50 маршрутов: кабинет (dashboard, loads, marketplace, orders, next-load, fuel, finance, documents, messages…), водитель (mobile-first: driver, driver/fuel, history, profile), админка (12 разделов), auth |

Роли (разные потребности интерфейса): грузовладелец, перевозчик-руководитель, диспетчер, экспедитор,
водитель (телефон, в дороге), администратор платформы.

## Порядок работы

1. **Скриншоты «до»** всех ключевых экранов на 1440 px и 390 px (Playwright, демо-аккаунты из seed) —
   сохранить в `docs/ui-audit/before/`.
2. **Дизайн-направление** через skill (для рабочего B2B-интерфейса, не лендинга):
   ```bash
   python3 .claude/skills/ui-ux-pro-max/scripts/search.py "logistics operations console B2B" \
     --design-system --variance 3 --motion 2 --density 8 -p CargoFlow
   ```
   Без `--density`/`--variance` skill склонен выбирать лендинговые паттерны и glassmorphism — для CargoFlow не подходит.
3. **Аудит по доменам** skill (`--domain ux`, `--domain style`, `--domain charts`, `--stack nextjs`, `--stack shadcn`)
   по каждому экрану: иерархия, плотность данных, таблицы на мобильных, формы и ошибки, состояния
   (пусто / загрузка / ошибка / нет прав), доступность (контраст 4.5:1, фокус, клавиатура, `prefers-reduced-motion`),
   тексты и терминология.
4. **Отчёт аудита** — `docs/archive/ui-audit-report.md`: проблемы с приоритетом (critical / high / medium / low), экран, скриншот, рекомендация.
5. **Редизайн слоями**, без изменения бизнес-логики и API:
   токены (`globals.css`) → базовые компоненты (`components/ui`) → общие (`components/common`) → каркас → экраны по ролям.
   Сохранить: реестр `StatusBadge`, `DataTable`/`FilterBar`/`UrlTabs`, `data-testid` (на них опираются E2E), нейтральные
   формулировки модуля «Топливо», пометки DEMO DATA.
6. **Проверка** после каждого слоя: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`,
   скриншоты «после» на тех же размерах.

## Известные исходные проблемы (подтверждены в коде)

Технический аудит проекта (безопасность, данные, API) — `docs/archive/AUDIT_REPORT.md`; UI/UX-аудит его дополняет, не дублирует.

- Шрифт Inter объявлен, но не загружается.
- Нет тёмной темы.
- KPI-карточки на `/fuel` при 6 показателях требуют аккуратной сетки (уже исправлено на `2xl:grid-cols-6`) — проверить аналогичные сетки на других страницах.
