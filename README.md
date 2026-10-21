# Safe Footpaths – 2-week plan page

One page that shows the ranked backlog, what each crew does each day, and the "Needs a human" list.
Dan can **move** a job to another crew/day, **lock** it where it is, or **unlock** it. Changes are saved to the
Google Sheet's *Overrides* tab, and the next run of the n8n workflow keeps them.

```
Browser ──► /api/plan ─────► n8n webhook sf-plan ──────► reads the Sheet tabs
        ──► /api/override ─► n8n webhook sf-override ──► writes the Overrides tab
             (passcode)        (x-sf-key header)
```

## Calendar (week plan)

The **Plan** tab is a week calendar for the 2-week plan: weeks as rows, Mon–Fri as columns, and one lane per crew
in each day.

- Drag a job onto a crew's lane to move it. On a phone, swipe sideways through the days and tap a job.
- **VIC school holidays** are shaded yellow and **public holidays** are hatched. The red **Upcoming holidays** list (top
  right) shows the next ones with their dates. All of these come from the Sheet's *Settings* tab
  (`school_holidays`, `public_holidays`), the same dates the planner uses.
- Dropping a job or clicking it opens the Move panel. It checks the move before saving: an N-day job needs N work days
  left, a 4-person job needs both crews, and the passcode is required (VeeValidate). The passcode field starts empty every
  time the panel opens.

## How it's built

- **Nuxt 4**, client-rendered, two server routes. No database: the Google Sheet is the store.
- The browser never sees the n8n key; Move/Lock needs the passcode.
- Works on a laptop (Dan) and a phone (crew lead).

## Run locally

```bash
cp .env.example .env   # fill in N8N_WEBHOOK_KEY, APP_PASSCODE, NUXT_PUBLIC_SHEET_URL
npm install
npm run dev
```

## Deploy (Vercel)

```bash
vercel link --scope <your-team>
vercel env add N8N_WEBHOOK_BASE production
vercel env add N8N_WEBHOOK_KEY production
vercel env add APP_PASSCODE production
vercel env add NUXT_PUBLIC_SHEET_URL production
vercel --prod
```

No client data lives in this repo — everything is read from the Sheet at runtime.
