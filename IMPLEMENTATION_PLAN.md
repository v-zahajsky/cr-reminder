## Implementační plán: ZenHub Ticket Review/QA Time Monitor Actor

### Cíl (Fáze 1)
Actor jednorázově (single run) načte tikety z jednoho nebo více ZenHub workspaces / repozitářů a spočítá, jak dlouho je každý tiket ve sloupci (pipeline) "Review" nebo "QA" (aktuálně přesný název je právě takto). Výstupem je dataset seřazený podle délky pobytu ve sloupci + informace o repository, issue number, title a assignees.

### Cíl (Fáze 2 – plán)
Možnost definovat konfigurovatelné prahy (např. 24h, 48h) pro zvýraznění "stárnoucích" tiketů. Workspaces / repositories již budou podporovány z Fáze 1. Actor bude agregovat výsledky a označovat překročené limity.

### Cíl (Fáze 3 – plán)
Slack notifikace (webhook) pro tikety překračující definované prahy. Volitelně souhrn + detailní seznam.

---

## Architektura (návrh)

Komponenty:
1. Input Loader: Načte a validuje `INPUT.json` (schema níže)
2. ZenHub Client: Odpovědný za volání ZenHub API (autorizace pomocí tokenu z inputu / env). Bude oddělena vrstva pro HTTP (fetch/axios) – preferuji `fetch` dostupný v Node 18.
3. Data Mapper: Převádí raw ZenHub data (issues + pipelines) na interní model IssueState { issueNumber, repository, pipelineName, enteredAt (odvozeno), currentDurationMs }
4. Duration Calculator: Určí dobu strávenou v cílové pipeline. (Nutné získat historii přes ZenHub API – zjistit dostupnost endpointů: event history / issue data obsahuje `pipelines`?). Pokud historie není přímo dostupná, bude potřebné uložit snapshot do Key-Value Store pro srovnání mezi běhy.
5. Persistence Layer: KV store (např. klíč `prevRun.json`) ukládající poslední známé pipeline/timestamp pro každé issue -> umožní aproximovat dobu ve sloupci. (Přesná historie je možná jen, pokud ZenHub API vrací timestamp vstupu do pipeline.)
6. Reporter (Fáze 1): Zapíše dataset `issues-with-review-duration` se záznamy + summary.
7. Threshold Evaluator (Fáze 2): Aplikuje definované prahy a taguje severity.
8. Slack Notifier (Fáze 3): Odešle zprávy.

### Poznámka k datům
Pokud ZenHub API poskytuje timestamp přechodu do pipeline, nepotřebujeme přetrvávající storage pro akumulaci. Pokud ne, první běh pouze inicializuje startTime = now, další běhy kumulují. (Edge case: issue přeskočí pipeline mezi dvěma běhy – ztratíme přesný vstupní čas; lze minimalizovat zkrácením intervalu běhu nebo volitelným experimentálním scrapingem eventů.)

---

## Návrh INPUT schématu (iterace 1)
Pilot (Fáze 1) – multi workspace (nebo přímo seznam repos):
```
{
  "zenhubToken": "<string>",
  // zatím neplánujeme používat GitHub token pokud ZenHub dá vše potřebné
  "targets": [
    {
      "repository": { "owner": "org-name", "name": "repo-name" }
      // nebo případně identifikátor workspace pokud bude potřeba (TODO upřesnit dle API)
    }
  ],
  "targetPipelines": ["Review", "QA"],
  "maxIssues": 100,              // ochranný limit, real expected ~15
  "outputDataset": "issues-with-review-duration",
  "timeGranularity": "minutes" // output formatting base (minutes -> display also hours/days aggregated)
}
```

Fáze 2 rozšíření:
```
{
  "projects": [
    {
      "repository": { "owner": "org", "name": "repo" },
      "targetPipelines": ["Review", "QA"],
      "thresholdsHours": [24, 48]
    }
  ],
  "slack": { "webhookUrl": "<string>", "notifyOn": "exceed-first|exceed-all|summary" },
  "global": { "defaultThresholdsHours": [24, 48], "maxIssues": 500 }
}
```

### Validace
Použít jednoduchou ruční validaci nebo knihovnu (např. `zod`). (Zvážit přidání do dependencies.) Pro Fázi 1 lze ručně.

---

## Interní datové struktury (TS)
```ts
type RepoRef = { owner: string; name: string };
type IssueKey = string; // `${owner}/${name}#${number}`

interface IssuePipelineSnapshot {
  issueNumber: number;
  repo: RepoRef;
  title: string;
  assignees: string[]; // GitHub usernames (or empty)
  pipeline: string;
  pipelineEnteredAt: string; // ISO timestamp
  updatedAt: string; // last seen
}

interface IssueDurationRecord extends IssuePipelineSnapshot {
  durationMs: number;
  durationHours: number;
  thresholdsExceeded?: number[]; // list of hours thresholds passed
}

interface PersistedState {
  issues: Record<IssueKey, IssuePipelineSnapshot>;
  lastRun: string; // ISO
  schemaVersion: 1;
}
```

---

## Postup Fáze 1 (MVP) – aktualizováno
1. Načíst input.
2. Inicializovat ZenHub klienta (pouze token z inputu).
3. Získat seznam issues pro všechny `targets`.
4. Enrich: získat title + assignees (pokud ZenHub data neobsahují, zvaž GitHub fallback – zatím nepoužijeme dokud nebude nutné).
5. Filtrovat na `targetPipelines`.
6. Načíst `prevRun` ze storage (KV store). Pokud neexistuje, prázdný.
7. Určit `pipelineEnteredAt` viz logika (API timestamp nebo fallback z persisted state nebo `now`).
8. Spočítat durations (ms -> derive minutes, hours, days:hours pro prezentaci / dataset fields e.g. durationMinutes, durationHours, durationHuman).
9. Seřadit podle délky sestupně.
10. Zapsat dataset + log summary (top 5 atd.).
11. Persistovat nový snapshot.
12. Ukončit Actor (single run).

---

## Návrh Slack notifikace (Fáze 3)
Bloková zpráva (Block Kit) s nadpisem + seznamem tiketů nad thresholdem. Minimal viable: plain text via webhook.

```json
{
  "text": "Tickets exceeding thresholds: 5 issues over 24h (repo xyz)"
}
```

Rozšíření: barevné zvýraznění podle nejvyššího překročeného prahu.

---

## Edge Cases & Rizika
1. Tiket rychle migruje mezi pipelines mezi běhy -> nepřesný start
2. Tiket zavřen / merged -> už se nevyskytne; je vhodné jej odstranit z persisted state
3. Rate limit / chyby API ZenHub/GitHub: implementovat retry (exponenciální backoff) a respektovat HTTP 429
4. Přejmenování pipeline -> staré snapshoty ztratí referenci; možno mapovat podle ID (pokud API dává)
5. Změna názvu repozitáře / přenos (jen poznámka – nízká pravděpodobnost)
6. Časová zóna: používat UTC a ISO stringy
7. Velký počet issues: stránkování a `maxIssues`

---

## Metriky / Logging
- Počet načtených issues
- Počet issues v target pipelines
- Průměrná / medián doba
- Nejdelší doba
- Počet přesahů prahů (Fáze 2)

---

## Testování (plán)
1. Unit: výpočet duration z persisted snapshotu.
2. Unit: threshold evaluator.
3. Integration (mock klient API) – scénář změny pipeline.
4. E2E suchý běh s mocked responses.

---

## Další možné rozšíření
- Export do Google Sheets / CSV
- Graf trendu (persistovat historii do datasetu a analyzovat)
- Konfigurace ignorovaných labelů / typů tiketů
- Multi-threading (sharding) u velkých orgs.

---

## Upřesnění z odpovědí
1. Pipeline names current: exact "Review", "QA".
2. ZenHub token will be provided via input field `zenhubToken`.
3. Multi workspaces / repositories from Phase 1 (array `targets`).
4. Single run (no internal polling loop) – scheduling handled externally (e.g. platform scheduler / cron).
5. Time precision: minutes acceptable; output also aggregated to hours and days (days + hours representation).
6. Output: full sorted list (desc by duration) including repository, issue number, title, assignees.
7. No notifications in Phase 1.
8. Expected max issues in target pipelines: ~15 (safe margin 100 limit).
9. Using github.com (no GH Enterprise) – prefer data only from ZenHub unless missing fields.
10. Output/log language: English.
11. Add `vitest` test framework in initial skeleton.
12. Ignore-label filtering postponed.

No further open questions remain for Phase 1; proceeding to skeleton after confirmation.


## Postup implementace (detail Fáze 1)
1. Přidat jednoduché typy a util funkce (`src/types.ts`, `src/utils/time.ts`).
2. Implementovat ZenHub client stub (`src/clients/zenhub.ts`) – zatím mock rozhraní + TODO: integrace API.
3. Persistence modul (`src/storage/state.ts`).
4. Hlavní orchestrátor (`src/runner.ts`) volaný z `main.ts`.
5. Přidat validaci inputu + logování metrik.
6. První testy (pokud přidáme testing framework – zvážit `vitest`).

Prosím potvrďte nebo upravte plán / odpovězte na otázky výše. Po schválení vytvořím skeleton kódu.
