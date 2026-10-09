# CargoFlow — AUDIT REPORT

Дата аудита: 2026-09-28. Ветка: `claude/full-project-audit-xokx5k`. Код в ходе аудита **не изменялся**.

## 0. Как проводился аудит

- Прочитаны все сервисы (`src/server/services/*`), все route handlers (`src/app/api/**`), ядро (`src/lib/**`: auth, permissions, state machines, payments, fuel, storage, validation), схема Prisma и все 5 миграций, seed (`prisma/seed.ts`, `seed-fuel.ts`), скрипты запуска, Dockerfile/railway/docker-compose, layouts и ключевые страницы/компоненты frontend, тесты.
- Запущены проверки:

| Проверка                                       | Результат                                                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                            | ✅ 0 ошибок                                                                                                                                                       |
| `npm run lint`                                 | ✅ 0 ошибок, 3 предупреждения (`react-hooks/incompatible-library`, `form.watch()` в `register-wizard.tsx:51`, `vehicle-components.tsx:170`, `load-wizard.tsx:87`) |
| `prettier --check`                             | ✅                                                                                                                                                                |
| `vitest --project unit`                        | ✅ 91/91                                                                                                                                                          |
| `vitest --project integration` (PostgreSQL 16) | ✅ 81/81; предупреждение `pg`: «client.query() when the client is already executing a query» (см. RACE-004)                                                       |
| `prisma migrate diff` (миграции ↔ schema)      | ✅ дрейфа нет                                                                                                                                                     |
| `npm run db:seed` на чистой БД                 | ✅ выполняется, но данные содержат невозможные даты (DATA-001)                                                                                                    |
| `npm audit`                                    | ⚠️ 4 high (транзитивно через `prisma` → `@prisma/config` → `deepmerge-ts`, `mysql2`)                                                                              |
| `npm outdated`                                 | мелкие минорные обновления (aws-sdk, dotenv, react-hook-form, react 19.3)                                                                                         |
| e2e (Playwright)                               | не запускались (требуют `next build` + браузер); проанализированы по коду                                                                                         |

Все зелёные тесты — **не** гарантия корректности: найденные ниже проблемы тестами не покрыты.

## 1. Архитектура (кратко)

```
Browser (RSC + client components)
  ├─ Server Components → services напрямую (чтение)             src/app/(app|driver|admin)/**
  └─ fetch → Route Handlers src/app/api/** → route(): Origin-check, сессия, rate limit, Idempotency-Key
                                   └─→ Service layer src/server/services/* (бизнес-логика, права, транзакции)
                                           ├─ access.ts / fuel-access.ts — связь пользователя с объектом
                                           ├─ order-core.ts — переход статуса заказа (lock → state machine → history → audit → notify)
                                           ├─ secure-deal.service.ts — платёжная state machine + PaymentProvider (sandbox/manual)
                                           └─ lib: permissions, state-machine, payments, fuel rules, storage(local/S3), notifications(log)
                                                   └─→ PostgreSQL (Prisma 7 + adapter-pg; partial unique indexes и CHECK в миграциях)
Внешние входы: webhooks платежей / топливных карт / телематики (HMAC), cron /api/system/jobs/secure-deal (Bearer CRON_SECRET)
```

Сущности и жизненные циклы: `Load (DRAFT→PUBLISHED→BIDDING→CARRIER_SELECTED→CONVERTED_TO_ORDER | CANCELLED)`, `Bid (PENDING→ACCEPTED|REJECTED|WITHDRAWN|EXPIRED)`, `TransportOrder (CARRIER_SELECTED→CONTRACT_PENDING→CONTRACT_SIGNED→VEHICLE_ASSIGNED→DRIVER_ASSIGNED→WAITING_FOR_LOADING→…→DELIVERED→CLOSED | CANCELLED | DISPUTED | ON_HOLD)`, `Contract`, `PaymentRecord SECURE_DEAL (PAYMENT_PENDING→AUTHORIZED→RESERVED→RELEASE_PENDING→RELEASED …)`, `Dispute`, `PlannedMovement`, `FuelCard/FuelTransaction/FuelAnomaly/FuelInvestigation`.

### Роли → права (фактические, `src/lib/permissions/index.ts`)

| Роль               | Разрешено                                                                                                                                                 | Запрещено / замечания                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| SHIPPER            | грузы, ставки (accept/reject/counter), заказ, договор (подпись), документы, чат, финансы (ред.), безопасная сделка, отзывы, споры, компания (управление!) | биржа. **Каждый** SHIPPER компании — «руководитель» (AUTHZ-005)                                                              |
| FORWARDER          | = SHIPPER + биржа (просмотр)                                                                                                                              | ставки делать не может                                                                                                       |
| CARRIER_ADMIN      | биржа, ставки, заказы, назначения, подпись, отмена, финансы (ред.), автопарк, водители, Next Load, топливо полностью, компания                            | —                                                                                                                            |
| CARRIER_DISPATCHER | как админ, без подписи, отмены, финансов (ред.), FUEL_MANAGE/FUEL_FINANCE_VIEW, управления компанией                                                      | по README «не видит деньги топлива» — фактически видит (AUTHZ-003)                                                           |
| DRIVER             | свой рейс, статусы, трекинг, документы (ограниченные типы), чат, своя топливная карта, план Next Load                                                     | по README «без финансов» — фактически видит цену груза/сделки (AUTHZ-002); видит профиль компании и её документы (AUTHZ-004) |
| PLATFORM_ADMIN     | всё                                                                                                                                                       | нет разделения «супер-админ»; демо-админ с публичным паролем (SEC-004)                                                       |

---

## 2. Список проблем

Формат: **ID · приоритет · категория** — Файл/место — Что не так — Почему проблема — Как воспроизвести — Что ломается / последствия — Исправление — Связанные файлы.

### 🔴 CRITICAL

**[CRITICAL] SEC-001 · Security / Secrets in logs**

- Файл: `src/lib/notifications/adapters.ts:65-68` (`sendEmail`), `:23-33`; `src/server/services/auth.service.ts:237-238`; `src/server/services/company.service.ts:207-212`; `src/config/env.ts:22` (default `log`).
- Проблема: единственная реализация e-mail — запись письма в stdout (`logger.info("email.dev", { to, subject, text })`). В `text` — полная ссылка сброса пароля с токеном и ссылка-приглашение с токеном. `EMAIL_DRIVER` по умолчанию `log` и в production. Logger редактирует только ключи `password|token|secret|…`, поле `text` не редактируется.
- Почему: любой, у кого есть доступ к логам хостинга (Railway, агрегатор логов, подрядчик), может сбросить пароль любого пользователя (включая администратора) и принять любое приглашение. Одновременно в production функция «Забыли пароль» для пользователя **не работает** (письмо не уходит).
- Воспроизвести: `POST /api/auth/forgot-password {"email":"admin@…"}` → в логах `email.dev … /reset-password?token=…` → открыть ссылку → новый пароль.
- Последствия: захват учётных записей; утечка PII (e-mail, тексты уведомлений) в логи для **каждого** уведомления (`EmailNotificationAdapter`).
- Исправление: реализовать реальный SMTP/API-адаптер; в production по умолчанию `EMAIL_DRIVER=none` и падать при старте, если нужен e-mail и драйвер не настроен; никогда не логировать тело писем/ссылки с токенами (или маскировать токен); добавить `text|link|url` в redact-список.
- Связанные: `src/lib/logger.ts`, `.env.example`, `README.md §5`.

**[CRITICAL] SEC-004 · Security / Default credentials**

- Файл: `scripts/demo-seed-if-empty.mjs`, `Dockerfile:25` (CMD), `prisma/seed.ts:35,238` (`admin@cargoflow.demo` / `Demo1234!`, `PLATFORM_ADMIN`), `src/features/auth/login-form.tsx:44,76-86`, `README.md §13`.
- Проблема: при `DEMO_SEED=1` контейнер в production создаёт платформенного администратора с публично известным паролем; при `NEXT_PUBLIC_SHOW_DEMO=1` страница входа сама подставляет пароль. После загрузки демо регистрация остаётся открытой — реальные пользователи регистрируются на стенде, где администратор имеет общеизвестный пароль.
- Воспроизвести: задеплоить по `railway.json` с `DEMO_SEED=1` → войти `admin@cargoflow.demo / Demo1234!`.
- Последствия: полный контроль над платформой (блокировка пользователей, решения по спорам и выплатам, настройки комиссии, аудит).
- Исправление: не создавать PLATFORM_ADMIN в демо-seed в production (или генерировать случайный пароль и печатать один раз); запретить `DEMO_SEED` при наличии не-демо пользователей и **закрыть регистрацию** на демо-стенде; явное предупреждение в UI «демо-стенд, данные публичны».
- Связанные: `railway.json`, `.env.example`.

### 🟠 HIGH

**[HIGH] SEC-002 · Security / Rate limiting bypass**

- Файл: `src/lib/auth/session.ts:20-25` (`getRequestMeta`), `src/lib/auth/rate-limit.ts`, `src/server/services/auth.service.ts:181,229`, `src/lib/api/handler.ts:83`.
- Проблема: IP берётся из **первого** значения `X-Forwarded-For`, которое контролирует клиент. Лимит входа — по ключу `ip:email`, т.е. отдельный счётчик на каждую пару; ограничения на аккаунт нет. Лимитер в памяти процесса.
- Почему: перебор паролей/credential stuffing не ограничен — достаточно менять заголовок `X-Forwarded-For` или e-mail. Так же обходятся лимиты регистрации и сброса пароля; в журнале аудита пишется поддельный IP.
- Воспроизвести: 11 запросов `POST /api/auth/login` с одним e-mail и разными `X-Forwarded-For: 1.1.1.N` — ни один не получает 429.
- Исправление: брать IP от доверенного прокси (последний/правый элемент или `x-real-ip`, выставляемый прокси; конфиг числа доверенных hop); добавить лимит на аккаунт (email) и прогрессивную блокировку; Redis-лимитер для нескольких инстансов.
- Связанные: `src/lib/audit/audit.ts` (ipAddress), `README.md §12.6`.

**[HIGH] SEC-003 · Security / IDOR (cross-tenant) через приглашение водителя**

- Файл: `src/lib/validation/company.ts:8-12` (`inviteSchema.driverProfileId`), `src/server/services/company.service.ts:151-215` (`inviteMember`), `src/server/services/auth.service.ts:128-131` (`consumeInvite`).
- Проблема: `driverProfileId` из тела запроса не проверяется на принадлежность компании приглашения. При принятии выполняется `driverProfile.update({ where: { id: invite.driverProfileId }, data: { userId } })` — **без** проверки компании и без проверки, что профиль уже привязан.
- Воспроизвести: CARRIER_ADMIN компании A → `POST /api/companies/{A}/invites {"email":"me@x","role":"DRIVER","driverProfileId":"<id водителя компании B>"}` → принять приглашение.
- Последствия: профиль водителя компании B переписывается на злоумышленника: настоящий водитель B теряет доступ к рейсу; злоумышленнику через `getMyTrip`/`listMyTrips` (`driver-trip.service.ts:35-45,70`, фильтр `driver.userId` **без** компании) и `ordersWhereForActor` (`access.ts:84`) становятся видны рейсы, маршруты, контакты и документы компании B. Требует знания UUID профиля (снижает вероятность, не устраняет).
- Исправление: в `inviteMember` проверять `driverProfile.companyId === companyId && userId == null && deletedAt == null`; в `consumeInvite` — `updateMany where {id, companyId, userId: null}` и проверка `count===1`; в driver-запросах фильтровать ещё и по `carrierCompanyId` членства DRIVER.
- Связанные: `src/server/services/fleet.service.ts:207,217`, `access.ts`.

**[HIGH] AUTHZ-001 · Authorization / Смешивание прав разных компаний**

- Файл: `src/server/services/company.service.ts:151-156` (`inviteMember` для DRIVER: `requirePermission` по **активной** компании + `assertCompanyAccess` — любое членство в целевой), `:217-223` (`revokeInvite`, то же), `load.service.ts:155-157` (`updateLoad`: `LOAD_EDIT` активной компании, а OWNER — любая customer-компания), `bid.service.ts:187-193` (`respondToCounter`: `BID_CREATE` активной компании), `load.service.ts:501-506` (`answerQuestion`), `load.service.ts:585-589` (`deleteLoadDocument` вообще без permission).
- Проблема: разрешение проверяется по роли в активной компании, а объект — в другой компании, где у пользователя может быть другая роль (например, DRIVER) или компания приостановлена (права view-only).
- Воспроизвести: пользователь — диспетчер в компании A (активная) и водитель в компании B. `POST /api/companies/{B}/invites {"role":"DRIVER",…}` → успешно приглашает людей в B; `DELETE /api/invites/{инвайт B}` → отзывает. Аналогично владелец груза в приостановленной компании редактирует груз, переключившись на другую активную компанию.
- Последствия: эскалация прав, обход приостановки компании.
- Исправление: всегда брать права из членства в компании объекта (`permissionsForMembership(membershipIn(actor, companyId))`), как это сделано в `resolveOrderAccess`; единый helper `requireCompanyPermission(actor, companyId, perm)`.
- Связанные: `src/lib/auth/actor.ts`, `access.ts`.

**[HIGH] BIZ-001 · Business logic / Подмена цены ставки перед принятием**

- Файл: `src/server/services/bid.service.ts:187-248` (`respondToCounter`), `:332-353` (`acceptBid`), `src/lib/validation/bid.ts:21-28`.
- Проблема: перевозчик действием `propose` может в любой момент изменить `amount` активной ставки — даже без встречного предложения и после истечения `validUntil` (нет `isBidExpired`, нет проверки `awaitingSide`). `acceptBid` принимает текущую сумму, не сверяя её с той, что видел заказчик. У `propose.amount` нет верхнего предела.
- Воспроизвести: заказчик открывает страницу ставок (4 200 USD) → перевозчик `POST /api/bids/{id}/respond {"action":"propose","amount":9000}` → заказчик нажимает «Принять» → создаётся заказ и договор на 9 000 USD.
- Последствия: финансовые потери заказчика, споры; договор формируется на сумму, которую заказчик не видел.
- Исправление: `acceptBid` должен принимать `expectedAmount`/версию ставки и отклонять при несовпадении; `propose` разрешать только при `awaitingSide === "CARRIER"`; проверять срок действия; ограничить сумму.
- Связанные: `src/features/loads/bid-components.tsx`.

**[HIGH] PAY-001 · Configuration / Sandbox-платежи в production**

- Файл: `.env.example:44` (`PAYMENT_PROVIDER="sandbox"`), `src/lib/payments/provider.ts:299-303`, `scripts/local.mjs` (копирует `.env.example` → `.env`).
- Проблема: пример окружения явно включает `sandbox`, который «успешно» резервирует и выплачивает без движения денег. Код защищает только случай «переменная не задана». Неизвестный код провайдера молча превращается в `manual`.
- Последствия: при копировании `.env.example` в production перевозчик видит «Оплата обеспечена», груз отгружается, денег нет. (UI помечает «Тестовый режим», но это легко пропустить.)
- Исправление: в production запрещать `sandbox` (ошибка на старте) без явного `ALLOW_SANDBOX_PAYMENTS=1`; в `.env.example` оставить пусто; логировать/падать на неизвестном провайдере.
- Связанные: `README.md §Secure Deal`.

**[HIGH] PAY-002 · Business logic / Деньги «замораживаются» бессрочно**

- Файл: `src/server/services/order.service.ts:688` → `secure-deal.service.ts:687-694` (`startConfirmationWindow`), `:810-821` (`processConfirmationTimeouts`), `:654-683`.
- Проблема: срок проверки (`confirmationDueAt`) выставляется только если в момент доставки платёж уже в `HELD`. Если резерв подтверждён позже (провайдер `manual` — подтверждение админом после доставки) или платёж был в споре/`RELEASE_PENDING`, `confirmationDueAt = null` → автоподтверждение никогда не сработает. Если заказчик подтвердил получение, а выплата не запросилась (нет POD, операция упала), `receiptConfirmedAt` уже установлен, и автозадача такой заказ тоже больше не берёт.
- Воспроизвести: `PAYMENT_PROVIDER=manual` → заказчик оформляет сделку → перевозчик доставляет → админ подтверждает RESERVE → ждать > 72 ч → выплаты нет, заказ навсегда DELIVERED.
- Последствия: нарушение обещания README «деньги не блокируются бесконечно»; перевозчик не получает оплату.
- Исправление: выставлять `confirmationDueAt` при переходе платежа в `RESERVED`, если заказ уже `DELIVERED`; автозадача должна повторно пытаться выплату для заказов с `receiptConfirmedAt` и `HELD`-платежом; алерт администратору.
- Связанные: `release-conditions.ts`, `applyProviderResult`.

**[HIGH] PAY-003 · Deployment / Плановая задача не запускается**

- Файл: `src/app/api/system/jobs/secure-deal/route.ts`, `railway.json`, `Dockerfile`, `README.md` («cron раз в 5–15 минут»).
- Проблема: в деплое нет планировщика; без внешнего cron и `CRON_SECRET` автоподтверждение и автовыплаты не выполняются никогда (только кнопкой админа).
- Последствия: ключевая гарантия безопасной сделки не работает в развёрнутом окружении.
- Исправление: описать/добавить cron (Railway cron service, GitHub Actions schedule, pg_cron) и health-метрику «просроченные подтверждения».

### 🟡 MEDIUM

**[MEDIUM] SEC-005 · Security / Open redirect после входа**

- Файл: `src/features/auth/login-form.tsx:37`.
- Проблема: проверка `next.startsWith("/") && !next.startsWith("//")` пропускает `/\evil.com` — браузеры трактуют `\` как `/` → `//evil.com`.
- Воспроизвести: `/login?next=%2F%5Cevil.com` → после входа переход на `evil.com` (фишинг «повторите вход»).
- Исправление: `new URL(next, location.origin).origin === location.origin`, либо whitelist путей.

**[MEDIUM] ERR-001 · Error handling / 500 вместо 404/422 на некорректном вводе**

- Файл: `src/lib/api/handler.ts:59-68` (`mapUnknownError` маппит только P2002/P2025/P2003); все `route<{ id }>` без валидации UUID; raw SQL `${id}::uuid` в `lockOrder/lockLoad/…`; `load.service.ts:405` (`q.status as LoadStatus`), `:428-429` (`new Date(dateFrom)`), `order.service.ts:55-60` (`status.split(",") as OrderStatus[]`, `carrierId`, `shipperId`, даты), `fuel-transaction.service.ts:456-462` (`from/to`), `chat.service.ts:319-320` (`before/after`).
- Проблема: невалидный UUID → Prisma P2023 / PostgreSQL `22P02`; невалидный enum/дата → ошибка валидации Prisma — всё уходит в `INTERNAL_ERROR 500` с логом `api.unexpected`.
- Воспроизвести: `GET /api/orders/abc`, `GET /api/loads?scope=mine&status=FOO`, `GET /api/orders?dateFrom=x`.
- Последствия: неверные коды ответа, шум в логах/алертах, страницы падают в error boundary вместо 404.
- Исправление: `z.uuid()` для всех path params в `route()`; enum/`z.coerce.date()` в query-схемах; маппинг P2023/22P02 → 404/422.

**[MEDIUM] AUTHZ-002 · Authorization / Водитель видит финансы сделки**

- Файл: `src/server/services/order.service.ts:103-132,173-181` (`getOrderDetail`: `load` включает `targetPrice`, `currency`, `additionalTerms`, `clientName`; `statusHistory` с комментарием «Принято предложение …: 4 200 USD» из `bid.service.ts:414`; `disputes` с описаниями), доступно водителю через `GET /api/orders/:id` и страницу `/orders/:id` (layout `(app)` водителя не ограничивает).
- Почему: README: «Водитель видит только свой рейс, без финансов и договора».
- Исправление: отдельный DTO для DRIVER (whitelist полей), не включать сумму в текст истории, закрыть `(app)`-страницы заказа для роли DRIVER.

**[MEDIUM] AUTHZ-003 · Authorization / Диспетчер видит деньги по топливу**

- Файл: `src/server/services/fuel-transaction.service.ts:498-509` (`getFuelTransaction` возвращает `totalAmount/pricePerLiter/authorizedAmount`), `fuel-investigation.service.ts:21-48` (anomalies включают `transaction.totalAmount`), `fuel-report.service.ts:271-321` (`tripFuelReport`: `cost` и транзакции без маскировки).
- Почему: README: «Диспетчер видит литры, но не деньги». Маскировка есть только в `listFuelTransactions` и `vehicleFuelReport`.
- Воспроизвести: войти `dispatcher@…` → `GET /api/fuel/transactions/{id}` или вкладка «Топливо» в перевозке.
- Исправление: единая функция `maskFuelMoney(actor, obj)` во всех выдачах.

**[MEDIUM] AUTHZ-004 · Authorization / Любой член компании видит её внутренние данные**

- Файл: `src/server/services/company.service.ts:49-52,64-95,284-289`; `src/app/api/companies/[id]/route.ts`.
- Проблема: `assertCompanyAccess` пропускает любую роль, включая DRIVER: список сотрудников с e-mail/телефонами, активные приглашения, регистрационные/налоговые документы (скачивание), журнал изменений.
- Исправление: требовать `COMPANY_VIEW` в роли этой компании; документы — `COMPANY_MANAGE`.

**[MEDIUM] AUTHZ-005 · Authorization / Нет владельца компании у SHIPPER/FORWARDER**

- Файл: `src/server/services/company.service.ts:54-61,225-255`.
- Проблема: все члены SHIPPER/FORWARDER-компании — «руководители»: любой может отключить остальных (в т.ч. основателя), править реквизиты, приглашать. Проверка «останется хотя бы один руководитель» есть только для CARRIER_ADMIN и неатомарна (два параллельных отключения → 0 админов).
- Исправление: роль владельца/админа для всех типов компаний; проверка последнего админа под блокировкой.

**[MEDIUM] SEC-008 · Security / Сессии и токены**

- Файл: `src/server/services/auth.service.ts:270-278` (смена пароля не завершает другие сессии), `:228-244` (старые токены сброса не аннулируются; время ответа различается для существующего/несуществующего e-mail), `:25-32` (регистрация раскрывает существование e-mail), `:117-119` (статус EXPIRED инвайта откатывается вместе с транзакцией).
- Исправление: revoke всех сессий кроме текущей при смене пароля; инвалидировать прежние reset-токены; выравнивать время ответа; переносить `EXPIRED` вне транзакции.

**[MEDIUM] SEC-011 · Security / DoS загрузками**

- Файл: `src/app/api/orders/[id]/documents/route.ts`, `companies/[id]/documents`, `loads/[id]/documents`, `fuel/investigations/[id]/attachments` (`req.formData()`), `src/lib/storage/file-validation.ts:81`.
- Проблема: тело multipart целиком читается в память до проверки размера (`MAX_UPLOAD_MB` проверяется по уже прочитанному `File`), лимит — 60 загрузок/мин на пользователя.
- Исправление: проверять `Content-Length` до парсинга, лимит тела на уровне прокси/Next, потоковая загрузка в S3 (presigned PUT).

**[MEDIUM] SEC-012 · Business/Security / Изменение реквизитов после верификации**

- Файл: `src/server/services/company.service.ts:131-147`, `src/lib/validation/company.ts:6`.
- Проблема: VERIFIED-компания может сменить `legalName`, `taxId`, адрес — значок «проверено» сохраняется.
- Исправление: изменение ключевых реквизитов → статус `PENDING`/повторная проверка.

**[MEDIUM] SEC-013 · Business / Самосделки и накрутка рейтинга**

- Файл: `src/server/services/company.service.ts:376-407` (неограниченное создание компаний), `bid.service.ts:54` (запрет только «своя компания»), миграция `Review_not_self`.
- Проблема: один пользователь создаёт компанию-грузовладельца и компанию-перевозчика, проводит фиктивные сделки и ставит себе 5★.
- Исправление: запрет ставок/сделок, если у пользователя есть членство в обеих компаниях; лимит создания компаний; отзывы только от верифицированных компаний.

**[MEDIUM] BIZ-003 · Business logic / Просроченные ставки**

- Файл: `src/server/services/bid.service.ts:24-29,138-148,187-199`, `load.service.ts:163-165`.
- Проблема: истечение ставок «ленивое» (только при создании/принятии); груз остаётся `BIDDING`, даже если все ставки истекли (его нельзя редактировать: «уже есть предложения»); в списках истёкшие ставки показываются активными; `respondToCounter` не проверяет срок.
- Исправление: вычислять статус на чтении или периодическая задача; при истечении последней ставки возвращать груз в `PUBLISHED`.

**[MEDIUM] BIZ-004 · Business logic / Отмена заказа уничтожает груз**

- Файл: `src/server/services/order.service.ts:294-332` (`load.status = CANCELLED`).
- Проблема: если перевозчик отменяет сделку до подписания, груз заказчика отменяется целиком — его нельзя вернуть на биржу, нужно создавать заново; принятая ставка остаётся `ACCEPTED`.
- Исправление: при отмене перевозчиком возвращать груз в `PUBLISHED` (с новым выбором), ставку помечать `WITHDRAWN`/`REJECTED`.

**[MEDIUM] BIZ-006 · Business logic / Устаревшие грузы на бирже**

- Файл: `src/server/services/load.service.ts:406-413`, `search.service.ts:116-132`.
- Проблема: биржа не отфильтровывает грузы с прошедшей датой загрузки и грузы приостановленных компаний; автоистечения грузов нет.
- Исправление: фильтр `loadingDateTo/loadingDateFrom >= now - grace`, исключать `SUSPENDED`, фоновая задача закрытия.

**[MEDIUM] BIZ-008 · Business logic / Удаление POD во время спора**

- Файл: `src/server/services/document.service.ts:165-200`.
- Проблема: запрет удаления POD/CMR действует только в статусе `DELIVERED`; после открытия спора (`DISPUTED`) загрузившая сторона может удалить доказательства (и «восстановится» предыдущая версия).
- Исправление: запрет удаления документов в `DISPUTED`/`ON_HOLD` и после доставки для всех типов, влияющих на выплату.

**[MEDIUM] BIZ-011 · Configuration / Противоречивые настройки платформы**

- Файл: `src/lib/validation/company.ts:71-94`, `settings.service.ts:295-313`, `order.service.ts:240-251`.
- Проблема: можно сохранить `requireSecureDeal=true` при `secureDealEnabled=false` → ни одна перевозка не может начать загрузку.
- Исправление: `superRefine` на схеме настроек.

**[MEDIUM] BIZ-012 · Business logic / Две противоречащие шкалы риска топлива**

- Файл: `src/lib/fuel/anomaly-rules.ts:93-100,137-161`; демо: оба несоответствия `severity=CRITICAL`, а `anomalyScore` заправок 30 и 40 («средний риск» по таблице README).
- Проблема: пользователь видит «Критично» у заправки со «средним» риском.
- Исправление: вычислять severity из итогового балла или показывать одну шкалу.

**[MEDIUM] BIZ-014 · Business logic / Ручные платежи меняются в одностороннем порядке**

- Файл: `src/server/services/payment.service.ts:356-467`.
- Проблема: любая сторона (в т.ч. плательщик) ставит `PAID`, отменяет счёт контрагента, меняет `paidAt` у оплаченного; нет блокировки строки и проверки статуса заказа (CLOSED/CANCELLED) в `updatePayment`.
- Исправление: `PAID` подтверждает получатель; отмена — автором или по согласию; `SELECT … FOR UPDATE`.

**[MEDIUM] BIZ-016 · Data model / Автомобили: уникальность и изменения**

- Файл: `prisma/schema.prisma:725` (`@@unique([country, plateNumber])` глобально, включая удалённые), `fleet.service.ts:91-146`.
- Проблема: номер, занятый удалённой машиной или машиной другой компании, нельзя зарегистрировать (сквоттинг номеров); у назначенной на рейс машины можно уменьшить грузоподъёмность/выключить GPS; удаление машины не отвязывает топливные карты и активные планы Next Load.
- Исправление: частичный уникальный индекс `WHERE "deletedAt" IS NULL` (и/или по компании); запрет изменения ключевых характеристик на рейсе; каскадная отвязка.

**[MEDIUM] BIZ-017 · Business logic / Назначение водителя без доступа**

- Файл: `src/server/services/order.service.ts:517-546`.
- Проблема: проверяется только `driver.userId`, но не `CompanyMember.status = ACTIVE` для этого пользователя → назначается отключённый сотрудник, который не увидит рейс (`buildActor` фильтрует неактивные членства).
- Исправление: проверять активное членство DRIVER в компании перевозчика.

**[MEDIUM] PAY-004 · Transactions / Решение по спору вне транзакции**

- Файл: `src/server/services/dispute.service.ts:116-211`, `secure-deal.service.ts:770-792`.
- Проблема: спор закрывается и заказ меняет статус в транзакции, а операции у провайдера — после; при ошибке (например, есть незавершённая операция) спор уже закрыт, деньги не распределены, повторной попытки/алерта нет. `validateDisputePaymentOutcome` выполняется до блокировки (TOCTOU).
- Исправление: записывать «ожидаемое решение» в БД и исполнять идемпотентной задачей с ретраями; алерт администратору.

**[MEDIUM] PAY-005 · Reliability / Зависшие операции провайдера**

- Файл: `src/server/services/secure-deal.service.ts:286-302`.
- Проблема: исключение провайдера оставляет операцию `PENDING` навсегда; уникальный индекс «одна PENDING-операция» блокирует все дальнейшие действия по платежу; нет задачи ретраев и мониторинга (кроме ручной кнопки).
- Исправление: фоновой ретрай с тем же ключом идемпотентности, таймаут → FAILED, метрика/алерт.

**[MEDIUM] RACE-002 · Concurrency / Идемпотентность неатомарна**

- Файл: `src/lib/api/handler.ts:85-116,118-127`.
- Проблема: «проверить ключ → выполнить → сохранить» без резервирования ключа: два параллельных запроса с одним ключом выполняются оба (защищают лишь бизнес-проверки); ключ не привязан к URL/телу (тот же ключ на другой заказ вернёт чужой сохранённый ответ); ошибки не сохраняются; сохранение `.catch(() => {})` глотает ошибки; таблица без TTL. Клиент генерирует новый ключ на каждую попытку (`use-action.ts:106`) — повтор после сетевой ошибки не защищён.
- Исправление: вставка ключа со статусом `IN_PROGRESS` до выполнения (unique), хранить hash запроса, TTL-очистка, переиспользовать ключ при ретрае.

**[MEDIUM] RACE-003 · Reliability / Внешние уведомления через setTimeout**

- Файл: `src/server/services/notification.service.ts:512-551`.
- Проблема: уведомление создаётся внутри транзакции, а через 250 мс таймер читает его вне транзакции. Если транзакция коммитится позже (долгие `acceptBid` с timeout 20 с) или откатывается — письмо тихо не отправляется. При рестарте процесса таймеры теряются. Комментарий «после фиксации транзакции» не соответствует коду.
- Исправление: outbox-таблица + воркер, или отправка после `await $transaction` в сервисе.

**[MEDIUM] RACE-004 · Compatibility / Параллельные запросы в одной транзакции**

- Файл: `src/server/services/fuel-transaction.service.ts:76-94` (`Promise.all` на `tx` в `cardUsage`).
- Проблема: два запроса одновременно на одном соединении транзакции — `pg` выдаёт DeprecationWarning (видно в тестах и seed) и в `pg@9` это станет ошибкой → авторизация заправок сломается при обновлении зависимостей.
- Исправление: последовательные `await` или один SQL с условной агрегацией.

**[MEDIUM] PERF-001 · Performance / Тяжёлый dashboard перевозчика**

- Файл: `src/server/services/next-load.service.ts:568-649` (`nextLoadPreviews`), `:528-562`.
- Проблема: на каждый показ dashboard — до 10 машин × (выборка до 500 грузов с include + matching) + N+1 запросы (`situationForOrder`, `plannedMovement.findFirst`). `nextLoadContext` — N+1 по машинам.
- Исправление: кэш/материализация превью, один запрос кандидатов на все машины, лимит по радиусу в SQL (PostGIS/bbox).

**[MEDIUM] CFG-002 · Configuration / APP_URL и cookies**

- Файл: `src/lib/auth/session.ts:16-18`, `src/lib/api/handler.ts:53`, `auth.service.ts:237`, `company.service.ts:207`.
- Проблема: флаг `Secure` у cookie зависит от `APP_URL`, которая не обязательна (дефолт `http://localhost:3000`); при незаданной переменной в production cookie сессии уходит без `Secure`, а ссылки в письмах ведут на localhost.
- Исправление: обязательная валидация `APP_URL` (https) в production на старте.

**[MEDIUM] CFG-003 · Deployment / Файлы теряются при передеплое**

- Файл: `Dockerfile:22` (`/app/storage`), `src/lib/storage/storage.ts:97-104` (дефолт `local`).
- Проблема: по умолчанию документы (CMR, POD, договорные фото, документы компаний) пишутся в файловую систему контейнера — на Railway она эфемерная.
- Исправление: в production требовать `STORAGE_DRIVER=s3` (или volume) и падать при старте иначе.

**[MEDIUM] CFG-004 · Deployment / Docker-образ**

- Файл: `Dockerfile:18`, `.dockerignore`.
- Проблема: runner копирует весь build-контекст (исходники, тесты, devDependencies, playwright и т.д.); `.dockerignore` исключает только `.env`, но не `.env.local`/`.env.production` — секреты могут попасть в образ; не используется `output: "standalone"`.
- Исправление: `.env*` в `.dockerignore`, standalone-сборка, `npm prune --omit=dev`, отдельный шаг миграций.

**[MEDIUM] CFG-005 · Data safety / Seed очищает любую БД вне NODE_ENV=production**

- Файл: `prisma/seed.ts:215-220`, `package.json` (`db:seed`, `db:reset`).
- Проблема: защита только по `NODE_ENV`. Запуск `npm run db:seed` локально с `DATABASE_URL`, указывающим на боевую БД, выполняет `TRUNCATE … CASCADE` всех таблиц.
- Исправление: проверка «в БД только демо-пользователи» (как в `demo-seed-if-empty.mjs`) + подтверждение имени БД.

**[MEDIUM] DATA-001 · Demo data / Невозможные даты**

- Файл: `prisma/seed.ts` (сдвиг дат `shift…`, стр. ~130-195).
- Проблема (проверено на реальной БД после seed):
  - `CF-O-000001`: `loadingDate` 2026-08-30, а `deliveredAt` 2026-08-29 — доставлено **до** загрузки;
  - `CF-O-000003`: загрузка 09-17, доставлено 09-16;
  - `CF-O-000004`: загрузка 09-28, доставлено 09-27;
  - весь рейс Урумчи → Москва (история статусов и трекинг) укладывается в ~1 секунду;
  - `CF-O-000002`: «прибыл на загрузку» 09-24 при дате загрузки 09-25.
- Последствия: демо противоречит бизнес-логике (timeline, расход топлива, KPI «вовремя»), вводит в заблуждение на показе.
- Исправление: сдвигать даты загрузки/доставки груза на тот же интервал, что и события; растягивать историю статусов по реалистичным интервалам.

**[MEDIUM] DB-001 · Database / Нет внешних ключей**

- Файл: `prisma/schema.prisma` — `CompanyDocument.uploadedByUserId`, `VerificationRequest.submittedByUserId/reviewerUserId`, `LoadDocument.uploadedByUserId`, `LoadQuestion.askedByUserId/answeredByUserId`, `Bid.decidedByUserId`, `TransportOrderStatusHistory.actorUserId`, `OrderDocument.uploadedCompanyId/deletedByUserId`, `Dispute.openedByUserId/openedByCompanyId/resolvedByUserId`, `DisputeComment.authorUserId`, `PaymentRecord.createdByUserId`, `PaymentTransaction.requestedByUserId`, `PlannedMovement.createdByUserId`, `CompanyInvite.invitedByUserId/acceptedByUserId/driverProfileId`, `FuelAnomaly.driverId/orderId/reviewedByUserId`, `FuelInvestigation.driverId/openedByUserId/closedByUserId`, `FuelInvestigationComment.authorUserId`, `FuelCard.createdByUserId`, `Review.fromUserId`, `TrackingEvent.userId`.
- Проблема: целостность не гарантируется БД; возможны «сироты» и ссылки на несуществующих пользователей/профили (см. SEC-003).
- Исправление: добавить relations/FK (onDelete: Restrict/SetNull).

**[MEDIUM] TEST-001 · Testing / Нет CI и покрытия критичных сценариев**

- Проблема: в репозитории нет CI (`.github/workflows` отсутствует) — 172 теста не запускаются автоматически. Не покрыты: open redirect, XFF/rate-limit, IDOR `driverProfileId`, смешивание прав компаний, маскировка денег для водителя/диспетчера, невалидные UUID (500), подмена цены ставки, зависание выплат (PAY-002), корректность дат demo-seed. E2E только в desktop-viewport, хотя водитель — мобильный сценарий.
- Исправление: CI (lint, typecheck, unit, integration с Postgres service, e2e smoke), тесты на перечисленные случаи.

### 🔵 LOW

**[LOW] SEC-006 · Security headers** — `next.config.ts`, `src/proxy.ts`: нет `Content-Security-Policy` и `Strict-Transport-Security`; пользовательские файлы отдаются inline с того же origin (`/api/documents/:id/download?inline=1`). Добавить CSP (default-src 'self' + tiles), HSTS, отдачу пользовательских файлов с отдельного домена/attachment.

**[LOW] SEC-007 · Content spoofing** — `src/app/forbidden/page.tsx:188-194` выводит произвольный текст из `?reason=` («Ваш аккаунт заблокирован, позвоните …»). Передавать код причины, а не текст.

**[LOW] SEC-010 · Webhooks** — `src/lib/payments/provider.ts:311-317` и два других webhook: нет временной метки/nonce (replay), один секрет на все значения `:provider` в URL (провайдер не аутентифицирован отдельно). Подпись `timestamp.body`, секрет на провайдера.

**[LOW] SEC-014 · Непроверенные перевозчики** — `bid.service.ts:43`: ставку может сделать и быть выбранным `UNVERIFIED`/`REJECTED` перевозчик; `requireVerifiedToPublish` действует только на грузовладельцев. Добавить настройку «только проверенные перевозчики».

**[LOW] AUTHZ-006 · Next Load: чужие планы** — `next-load.service.ts:505`: условие `m.createdByUserId !== actor.userId && m.driverId === null` пропускает водителя к любому плану компании с `driverId != null`. Сравнивать `driverId` с профилем текущего водителя.

**[LOW] BIZ-002 · Валюта/цена ставки** — `bid.service.ts:37-117`: валюта ставки может отличаться от валюты груза; для `priceType = FIXED` принимается любая сумма. Согласовать правила.

**[LOW] BIZ-005 · Правка опубликованного груза** — `load.service.ts:154-207`: при редактировании `PUBLISHED`-груза не повторяются проверки публикации (запрещённые типы грузов, прошедшие даты). Можно создать груз с датой загрузки в прошлом (`validation/load.ts` не проверяет).

**[LOW] BIZ-007 · Мёртвый статус** — `order.service.ts:556-573`: `assignDriver` сразу переводит `DRIVER_ASSIGNED → WAITING_FOR_LOADING`; ручной переход «Готов к загрузке» (`order-state-machine.ts:117`) недостижим. Статусы `DRAFT/PUBLISHED/CARRIER_SELECTION` у `OrderStatus` не используются вовсе.

**[LOW] BIZ-009 · Отмена через спор** — `dispute.service.ts:141-158`: исход `CANCEL` не выполняет побочные эффекты `cancelOrder` (отмена договора, груза, плановых ручных платежей).

**[LOW] BIZ-013 · Статусы EXPIRED не выставляются** — `MovementStatus.EXPIRED`, `FuelCardStatus.EXPIRED` нигде не устанавливаются; планы Next Load с прошедшим `availableUntil` остаются `ACTIVE` и участвуют в подборе/уведомлениях.

**[LOW] BIZ-015 · Дублирующее событие трекинга** — `order.service.ts:752`, `secure-deal.service.ts:663`: при подтверждении получения создаётся второе событие `DELIVERED` — в таймлайне две «доставки».

**[LOW] BIZ-018 · Статус истёкшего приглашения** — `auth.service.ts:117-119`: `update(EXPIRED)` откатывается вместе с транзакцией из-за последующего throw.

**[LOW] BIZ-020 · Кнопка-заглушка** — `src/features/orders/finance-panel.tsx:62-68,99`: «Изменить стоимость» всегда вызывает `POST /api/orders/:id/price`, который всегда отвечает 403 (`order.service.ts:817-827`) и пишет `api.denied` в лог. Убрать кнопку или реализовать запрос администратору.

**[LOW] BIZ-021 · Одобрение приостановленной компании** — `admin.service.ts:231-326`: `APPROVE` у `SUSPENDED` компании обходит `RESTORE`, `suspendedAt/suspendReason` остаются.

**[LOW] BIZ-022 · Голодание автозадачи** — `secure-deal.service.ts:812-821`: `take: 200` без сортировки; заказы, пропущенные из-за отсутствия POD, выбираются каждый раз и могут вытеснить остальные.

**[LOW] BIZ-024 · Прочтение чата** — `chat.service.ts:353-363`: `ChatMessage.readAt` один на сообщение — «прочитано» любым участником; GET-запрос опроса (каждые 5 с) выполняет запись в БД.

**[LOW] RACE-001 · Потеря сообщений чата** — `chat-panel.tsx:63-75` + `chat.service.ts:319-320`: курсор `createdAt > lastAt`; сообщение, закоммиченное позже с более ранним `createdAt`, не придёт до перезагрузки. Использовать монотонный seq/ID-курсор.

**[LOW] PERF-002 · Прочая производительность** — `chat.service.ts:440-455` (N+1 подсчёт непрочитанных), `payment.service.ts:487-494` (все заказы пользователя без пагинации для итогов), `settings.service.ts:289` (чтение настроек из БД на каждый вызов, в т.ч. в каждой транзакции), `contract.service.ts:180`/`document.service.ts:155` (запись аудита на каждый просмотр), `dashboard.service.ts` (до 14 параллельных запросов на рендер при пуле `pg` по умолчанию 10).

**[LOW] PERF-003 · Поиск** — `contains … insensitive` по названиям/городам без trigram-индексов, offset-пагинация на бирже.

**[LOW] PERF-004 · Масштабирование** — in-memory rate limiter и кэш (признано в README), notification-таймеры в процессе.

**[LOW] CFG-001 · Мёртвая конфигурация** — `src/config/env.ts` нигде не импортируется (валидация env не выполняется); `hmac/verifyHmac` в `src/lib/auth/tokens.ts` не используются — `APP_SECRET` фактически не нужен, хотя `.env.example`/README описывают его как «секрет для подписи ссылок на файлы».

**[LOW] CFG-006 · Demo-seed guard** — `scripts/demo-seed-if-empty.mjs:18`: любой зарегистрированный пользователь с e-mail `…@cargoflow.demo` считается демо — при неполном демо следующий старт выполнит TRUNCATE его данных.

**[LOW] DEP-001 · Зависимости** — `npm audit`: 4 high (транзитивно `prisma` → `@prisma/config` → `deepmerge-ts`; `mysql2`), CLI `prisma` в `dependencies` (runtime-образ); `embedded-postgres` — beta; мелкие отставания версий. Отслеживать исправления, вынести CLI в отдельный stage.

**[LOW] DOC-001 · Документация ↔ код** — README: «10 грузов, 4 компании» (фактически 19 грузов, 5 компаний); «деньги не блокируются бесконечно» (см. PAY-002); «cron раз в 5–15 минут» (не настроен, PAY-003); «диспетчер видит литры, но не деньги» (AUTHZ-003); «водитель без финансов» (AUTHZ-002); `APP_SECRET` «для подписи ссылок» (не используется).

**[LOW] AUDIT-001 · Атрибуция аудита** — `order-core.ts:519`, `secure-deal.service.ts:122,253`: `companyId` записи аудита берётся из активной компании актора, а не из компании сделки — у администратора и пользователей с несколькими компаниями записи попадают «не в ту» компанию.

**[LOW] VAL-001 · Валидация** — `z.coerce.boolean()` превращает строку `"false"` в `true` (`validation/company.ts:52,81-92`, `validation/load.ts:79`); `bidRespondSchema.propose.amount`, `priceChangeSchema.amount`, `paymentCreateSchema.amount` без верхней границы; `vehicleSchema.year.max` вычисляется при загрузке модуля (устаревает у долгоживущего процесса); `contactPhone` не проверяется как телефон; дата заправки владельцем (`fuelPurchaseSchema.transactionDate`) и показания телематики могут быть в будущем.

**[LOW] TZ-001 · Часовые пояса** — `fuel-transaction.service.ts:459-460`: фильтр дат с жёстким `+05:00`; время подписи в PDF (`contract.service.ts:340`) — UTC без указания пояса.

**[LOW] DB-002 · Рост таблиц** — нет очистки `IdempotencyKey`, `Session` (истёкшие/отозванные), `PasswordResetToken`, `Notification`, `TelemetryReading`.

**[LOW] CODE-001 · Мёртвый код / неиспользуемые endpoints** — `resumeOrder` (`order.service.ts:833`), `requestPriceChange`; API без UI: `POST /api/loads/:id/documents`, `GET|DELETE /api/load-documents/:id`, `POST /api/fuel/transactions` (симулятор владельца), `POST /api/fuel/vehicles/:id/telemetry`, `GET /api/next-load/previews`.

**[LOW] LINT-001 · React Compiler** — 3 предупреждения `react-hooks/incompatible-library` (`form.watch()`): компоненты не мемоизируются; заменить на `useWatch`.

**[LOW] UX-001 · Чат-вложения** — `chat-panel.tsx:101-108`: любое изображение из чата сохраняется как `CARGO_PHOTO`; если отправка сообщения упала, загруженный документ остаётся «сиротой» в документах рейса.

---

## 3. Итоговая таблица

| Приоритет   | Кол-во | ID                                                                                                                                                                                                                                                                                                          |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 CRITICAL | 2      | SEC-001, SEC-004                                                                                                                                                                                                                                                                                            |
| 🟠 HIGH     | 7      | SEC-002, SEC-003, AUTHZ-001, BIZ-001, PAY-001, PAY-002, PAY-003                                                                                                                                                                                                                                             |
| 🟡 MEDIUM   | 32     | SEC-005, ERR-001, AUTHZ-002, AUTHZ-003, AUTHZ-004, AUTHZ-005, SEC-008, SEC-011, SEC-012, SEC-013, BIZ-003, BIZ-004, BIZ-006, BIZ-008, BIZ-011, BIZ-012, BIZ-014, BIZ-016, BIZ-017, PAY-004, PAY-005, RACE-002, RACE-003, RACE-004, PERF-001, CFG-002, CFG-003, CFG-004, CFG-005, DATA-001, DB-001, TEST-001 |
| 🔵 LOW      | 31     | SEC-006, SEC-007, SEC-010, SEC-014, AUTHZ-006, BIZ-002, BIZ-005, BIZ-007, BIZ-009, BIZ-013, BIZ-015, BIZ-018, BIZ-020, BIZ-021, BIZ-022, BIZ-024, RACE-001, PERF-002, PERF-003, PERF-004, CFG-001, CFG-006, DEP-001, DOC-001, AUDIT-001, VAL-001, TZ-001, DB-002, CODE-001, LINT-001, UX-001                |

**Total issues: 72** — CRITICAL: 2 · HIGH: 7 · MEDIUM: 32 · LOW: 31

## 4. План

1. **Немедленно:** SEC-001 (токены в логах), SEC-004 (демо-админ), SEC-002 (XFF/лимиты входа), SEC-003 (IDOR инвайта водителя), AUTHZ-001 (права из компании объекта), BIZ-001 (подмена цены), PAY-001 (sandbox в prod).
2. **Следующим этапом:** PAY-002/003/004/005 (надёжность выплат и планировщик), SEC-005, ERR-001, AUTHZ-002…005, BIZ-008, BIZ-014, RACE-002/003/004, CFG-002/003/005, DATA-001, TEST-001 (CI).
3. **Позже:** остальные MEDIUM (BIZ-003/004/006/011/012/016/017, SEC-008/011/012/013, PERF-001, CFG-004, DB-001) и LOW-пункты UX/валидации.
4. **Технический долг:** CFG-001, CODE-001, LINT-001, DB-002, AUDIT-001, TZ-001, DOC-001, мёртвые статусы (BIZ-007, BIZ-013).
5. **Архитектурные проблемы:** права вычисляются из «активной компании», а не из связи с объектом (AUTHZ-001) — нужен единый слой `requireCompanyPermission`; побочные эффекты (письма, платежи, решения по спорам) выполняются вне транзакции без outbox/ретраев (RACE-003, PAY-004/005); нет фоновых задач (истечение ставок, грузов, планов, выплат); DTO не разделены по ролям (утечки денег водителю/диспетчеру); ссылочная целостность держится на коде, а не на FK.
6. **Проявятся при росте нагрузки:** in-memory rate limiter/таймеры (несколько инстансов), dashboard перевозчика (PERF-001), подбор Next Load полным перебором 500 грузов, N+1 в чатах/итогах финансов, опрос чата каждые 5 с с записью в БД, текстовый поиск без индексов, неограниченный рост таблиц (DB-002), загрузки файлов в память (SEC-011), `take: 200` в автозадаче (BIZ-022).

## 5. Статус исправлений (2026-09-28)

| Приоритет   | Коммиты              | Статус                            |
| ----------- | -------------------- | --------------------------------- |
| 🔴 CRITICAL | `43e865b`            | ✅ исправлено                     |
| 🟠 HIGH     | `d64b103`            | ✅ исправлено                     |
| 🟡 MEDIUM   | `ee8a60e`, `e1996a7` | ✅ исправлено                     |
| 🔵 LOW      | `fc88288`            | ✅ исправлено, кроме пунктов ниже |

Оставлено как задокументированный технический долг (требует архитектурного решения, описано в README):

- **PERF-003** — trigram-индексы и keyset-пагинация для поиска: нужны при росте данных.
- **PERF-004** — in-memory rate limiter, кэш настроек и планировщик в процессе: при нескольких инстансах нужен Redis или внешний cron (задачи уже идемпотентны).
- **CODE-001 (частично)** — мёртвые `resumeOrder`, `requestPriceChange` и `/api/orders/:id/price` удалены; API-only endpoints оставлены намеренно и перечислены в README.
- **BIZ-007** — неиспользуемые значения enum `OrderStatus` не удаляются: для этого нужна миграция enum; переход задокументирован в state machine.

Проверки после всех исправлений: `typecheck` ✅, `lint` ✅ (0 ошибок и 0 предупреждений), `prettier` ✅, `vitest` ✅ 200/200 (unit и integration на PostgreSQL 16), `prisma migrate diff` ✅ без дрейфа, `next build` ✅, `npm audit` ✅ 0 уязвимостей. Smoke-проверка production-сборки: CSP без нарушений в браузере, некорректные id дают 404/422 вместо 500.
