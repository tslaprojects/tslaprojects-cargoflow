@AGENTS.md

## UI/UX работа

Для любых задач по интерфейсу (страницы, компоненты, токены, доступность, редизайн) используй skill
**ui-ux-pro-max** (`.claude/skills/ui-ux-pro-max`). Дизайн-система (токены, типографика, motion, компоненты) — `docs/design-system.md`; прежние аудиты — `docs/archive/` (исторические, не обновляются).

- Стек для запросов skill: `--stack nextjs` и `--stack shadcn` (Next.js 16, React 19, Tailwind 4, radix-ui).
- CargoFlow — плотный рабочий B2B-интерфейс, не лендинг: для `--design-system` задавай `--density 7-9 --motion 1-3`.
- Интерфейс только на русском; сохраняй `data-testid` (E2E), реестр `StatusBadge`, общие компоненты из `src/components/common`.
- Бизнес-логику, API и права при редизайне не меняй; после изменений — typecheck, lint, тесты, E2E.
