<script setup lang="ts">
import type { PlanData, PlanRow, OverrideRow } from '../shared/types'

const config = useRuntimeConfig()
// First load may come from Vercel's edge cache (fast). Refresh / after a save asks for fresh data.
const fresh = ref(0)
const { data, pending, error } = useFetch<PlanData>('/api/plan', {
  server: false,
  query: computed(() => (fresh.value ? { fresh: fresh.value } : {})),
})
const reloadFresh = () => { fresh.value = Date.now() }

const tab = ref<'plan' | 'ranked' | 'human'>('plan')
const s = (v: unknown) => String(v ?? '').trim()
// "Councils and Shires - 13661" -> "Councils and Shires" (the job number is already shown in bold)
const org = (name: unknown, job: unknown) => s(name).replace(new RegExp(`\\s*-\\s*${s(job)}$`), '')

// A crew lead on a phone only wants their own crew. Remembered per device.
const crewFilter = ref<'all' | 'A' | 'B'>('all')
onMounted(() => {
  try { const v = localStorage.getItem('sf-crew'); if (v === 'A' || v === 'B') crewFilter.value = v } catch {}
})
watch(crewFilter, (v) => { try { localStorage.setItem('sf-crew', v) } catch {} })

// ---- settings -> work days in the window (weekdays, minus public holidays) ----
const settings = computed(() => Object.fromEntries((data.value?.settings ?? []).map((r) => [s(r.key), s(r.value)])))
const allCrews = computed(() => [
  { id: 'A', name: settings.value.crew_A || 'Crew A' },
  { id: 'B', name: settings.value.crew_B || 'Crew B' },
])
const crews = computed(() => allCrews.value.filter((c) => crewFilter.value === 'all' || c.id === crewFilter.value))
const holidays = computed(() => new Set((settings.value.public_holidays || '').split(';').map((x) => x.trim()).filter(Boolean)))
const workDays = computed(() => {
  const start = settings.value.window_start
  const end = settings.value.window_end
  if (!start || !end) return [...new Set((data.value?.plan ?? []).map((p) => s(p.day)))].sort()
  const out: string[] = []
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    if (d.getUTCDay() % 6 !== 0 && !holidays.value.has(iso)) out.push(iso)
  }
  return out
})
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { ...o, timeZone: 'UTC' })
const dayLabel = (iso: string) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' })

// ---- calendar: Mon–Fri columns, one row per week that the plan touches ----
const weeks = computed(() => {
  const days = workDays.value
  if (!days.length) return []
  const monday = new Date(days[0] + 'T00:00:00Z')
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const out: { label: string; days: { iso: string; work: boolean; holiday: boolean }[] }[] = []
  for (; monday.toISOString().slice(0, 10) <= days.at(-1)!; monday.setUTCDate(monday.getUTCDate() + 7)) {
    const cells = Array.from({ length: 5 }, (_, i) => {
      const d = new Date(monday)
      d.setUTCDate(d.getUTCDate() + i)
      const iso = d.toISOString().slice(0, 10)
      return { iso, work: days.includes(iso), holiday: holidays.value.has(iso) }
    })
    const short = (iso: string) => fmt(iso, { day: 'numeric', month: 'short' })
    out.push({ label: `Week ${out.length + 1} · ${short(cells[0]!.iso)} – ${short(cells[4]!.iso)}`, days: cells })
  }
  return out
})

const cell = (day: string, crew: string) => (data.value?.plan ?? []).filter((p) => s(p.day) === day && s(p.crew).split('+').includes(crew))
// Each day: both-crew jobs once on top, then one lane per crew (the lanes are the drop targets).
const bothJobs = (day: string) => (data.value?.plan ?? []).filter((p) => s(p.day) === day && s(p.crew) === 'A+B')
const laneJobs = (day: string, crew: string) => (data.value?.plan ?? []).filter((p) => s(p.day) === day && s(p.crew) === crew)
const crewClass = (crew: unknown) => 'crew-' + (s(crew) === 'A+B' ? 'AB' : s(crew))
const lastRun = computed(() => (data.value?.runs ?? []).at(-1))

// Latest override per job (the tab keeps one row per job, but be safe).
const overrides = computed(() => {
  const m = new Map<string, OverrideRow>()
  for (const o of data.value?.overrides ?? []) if (s(o.job)) m.set(s(o.job), o)
  return m
})
const pendingChanges = computed(() => {
  const ran = s(lastRun.value?.run_at)
  return [...overrides.value.values()].filter((o) => s(o.updated_at) > ran)
})
const lockedNow = (job: unknown) => {
  const o = overrides.value.get(s(job))
  return !!o && s(o.action) !== 'unlock'
}
// Saved moves the planner hasn't applied yet, shown as a dashed "moving here" note in the target lane.
const movingInto = (day: string, crew: string) =>
  pendingChanges.value.filter((o) => s(o.action) === 'move' && s(o.day) === day && s(o.crew).split('+').includes(crew))

// ---- drag and drop (mouse): drop a job on a crew's lane -> the Move panel opens pre-filled, Dan presses Save ----
const dragJob = ref('')
const dropAt = ref('')
function startDrag(e: DragEvent, job: unknown) {
  dragJob.value = s(job)
  e.dataTransfer?.setData('text/plain', s(job))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function endDrag() { dragJob.value = ''; dropAt.value = '' }
function leaveLane(e: DragEvent) {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropAt.value = ''
}
function dropOn(day: string, crew: string) {
  const job = dragJob.value
  endDrag()
  if (!job) return
  openEdit(job)
  if (!editing.value) return
  form.day = day
  if (editing.value.techs <= 2) form.crew = crew
  editing.value.dropped = true
}

// ---- Move / Lock panel ----
const editing = ref<{ job: string; title: string; techs: number; current?: PlanRow; dropped?: boolean } | null>(null)
const form = reactive({ crew: 'A', day: '' })
const passcode = ref(import.meta.client ? localStorage.getItem('sf-passcode') || '' : '')
const saving = ref(false)
const message = ref('')

function openEdit(job: unknown) {
  const id = s(job)
  const r = data.value?.ranked.find((x) => s(x.job) === id)
  const current = data.value?.plan.find((p) => s(p.job) === id)
  const techs = Number(r?.techs ?? current?.techs ?? 2)
  editing.value = { job: id, title: `${id} · ${org(r?.organisation || current?.organisation, id)}`, techs, current }
  form.crew = techs > 2 ? 'A+B' : s(current?.crew) || 'A'
  form.day = s(current?.day) || workDays.value[0] || ''
  message.value = ''
}

async function save(action: 'lock' | 'move' | 'unlock') {
  if (!editing.value) return
  saving.value = true
  message.value = ''
  try {
    const body =
      action === 'lock' && editing.value.current
        ? { job: editing.value.job, action, crew: s(editing.value.current.crew), day: s(editing.value.current.day) }
        : { job: editing.value.job, action, crew: form.crew, day: form.day }
    await $fetch('/api/override', { method: 'POST', body: { ...body, passcode: passcode.value } })
    localStorage.setItem('sf-passcode', passcode.value)
    message.value = action === 'unlock' ? 'Unlocked. The next run places it again.' : 'Saved. The next workflow run keeps it.'
    reloadFresh()
  } catch (e: any) {
    message.value = e?.statusCode === 401 ? 'Wrong passcode.' : e?.statusMessage || e?.data?.statusMessage || 'Could not save.'
    if (e?.statusCode === 401) localStorage.removeItem('sf-passcode')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page">
    <header>
      <div>
        <h1>Safe Footpaths · 2-week plan</h1>
        <p class="muted" v-if="lastRun">
          Last run {{ lastRun.run_at }} ·
          <span :class="s(lastRun.ok) === 'PASS' ? 'ok' : 'bad'">checks {{ lastRun.ok }}</span> ·
          {{ lastRun.placed }} of {{ lastRun.jobs }} jobs placed
        </p>
      </div>
      <div class="actions">
        <button @click="reloadFresh()" :disabled="pending">{{ pending ? 'Loading…' : 'Refresh' }}</button>
        <a v-if="config.public.sheetUrl" :href="config.public.sheetUrl" target="_blank" rel="noopener">Open Google Sheet</a>
      </div>
    </header>

    <p v-if="error" class="banner bad">Couldn't load the plan: {{ error.statusMessage || error.message }}</p>
    <div v-if="pending && !data" class="loading">
      <div class="spinner" />
      <p>Loading the plan from the Google Sheet… this takes a few seconds.</p>
    </div>
    <p v-if="pendingChanges.length" class="banner">
      {{ pendingChanges.length }} change(s) by Dan saved since the last run — run the workflow to apply:
      {{ pendingChanges.map((o) => `${s(o.job)} ${s(o.action)}`).join(', ') }}
    </p>

    <nav v-if="data">
      <div class="tabs">
        <button :class="{ on: tab === 'plan' }" @click="tab = 'plan'">Plan</button>
        <button :class="{ on: tab === 'ranked' }" @click="tab = 'ranked'">Ranked <b>{{ data.ranked.length }}</b></button>
        <button :class="{ on: tab === 'human' }" @click="tab = 'human'">Needs a human <b>{{ data.needsHuman.length }}</b></button>
      </div>
      <div v-if="tab === 'plan'" class="tabs crewpick" aria-label="Show crew">
        <button :class="{ on: crewFilter === 'all' }" @click="crewFilter = 'all'">Both crews</button>
        <button :class="{ on: crewFilter === 'A' }" @click="crewFilter = 'A'">Crew A</button>
        <button :class="{ on: crewFilter === 'B' }" @click="crewFilter = 'B'">Crew B</button>
      </div>
    </nav>

    <!-- Calendar: weeks as rows, Mon–Fri as columns (on a phone, swipe sideways through the days) -->
    <section v-if="tab === 'plan' && data" class="cal">
      <p class="legend small">
        <span v-for="c in allCrews" :key="c.id" :class="crewClass(c.id)"><i class="chip">Crew {{ c.id }}</i> {{ c.name }}</span>
        <span class="crew-AB"><i class="chip">Both</i> 4-person job</span>
      </p>
      <div v-for="w in weeks" :key="w.label" class="week">
        <h2>{{ w.label }}</h2>
        <div class="weekgrid">
          <article v-for="c in w.days" :key="c.iso" class="cell" :class="{ off: c.holiday, out: !c.work && !c.holiday }">
            <h3>{{ dayLabel(c.iso) }}</h3>
            <p v-if="c.holiday" class="small muted">Public holiday · no work</p>
            <p v-else-if="!c.work" class="small muted">Not in this plan</p>
            <template v-else>
              <button v-for="p in bothJobs(c.iso)" :key="s(p.job) + p.part" class="job crew-AB" draggable="true"
                @dragstart="startDrag($event, p.job)" @dragend="endDrag" @click="openEdit(p.job)">
                <i class="chip">Both</i>
                <strong>{{ s(p.job) }}</strong> {{ org(p.organisation, p.job) }}
                <span class="small">{{ p.suburb }} · {{ s(p.days) }}d {{ p.part }}</span>
                <span class="small muted reason">{{ p.reason }}</span>
                <span v-if="s(p.source).startsWith('Dan')" class="tag">🔒 {{ p.source }}</span>
              </button>
              <div v-for="cr in crews" :key="cr.id" class="lane" :class="[crewClass(cr.id), { drop: dropAt === c.iso + cr.id }]"
                @dragover.prevent="dropAt = c.iso + cr.id" @dragleave="leaveLane" @drop.prevent="dropOn(c.iso, cr.id)">
                <button v-for="p in laneJobs(c.iso, cr.id)" :key="s(p.job) + p.part" class="job" :class="crewClass(p.crew)" draggable="true"
                  @dragstart="startDrag($event, p.job)" @dragend="endDrag" @click="openEdit(p.job)">
                  <i class="chip">Crew {{ cr.id }}</i>
                  <strong>{{ s(p.job) }}</strong> {{ org(p.organisation, p.job) }}
                  <span class="small">{{ p.suburb }} · {{ s(p.days) }}d {{ p.part }}</span>
                  <span class="small muted reason">{{ p.reason }}</span>
                  <span v-if="s(p.source).startsWith('Dan')" class="tag">🔒 {{ p.source }}</span>
                </button>
                <p v-for="o in movingInto(c.iso, cr.id)" :key="s(o.job)" class="small ghost">↪ {{ s(o.job) }} moving here (next run)</p>
                <p v-if="!laneJobs(c.iso, cr.id).length && !cell(c.iso, cr.id).length && !movingInto(c.iso, cr.id).length" class="small free">
                  Crew {{ cr.id }} free
                </p>
              </div>
            </template>
          </article>
        </div>
      </div>
    </section>

    <!-- Ranked backlog -->
    <section v-if="tab === 'ranked'" class="list">
      <div v-for="r in data?.ranked ?? []" :key="s(r.job)" class="row">
        <div class="rank">{{ s(r.rank) }}</div>
        <div class="grow">
          <strong>{{ s(r.job) }}</strong> {{ org(r.organisation, r.job) }}
          <span class="small muted">{{ r.suburb }} · {{ s(r.techs) }} techs · {{ s(r.days) }} day(s)</span>
          <div class="small">{{ r.reason }}</div>
          <div class="small" :class="s(r.planned).startsWith('Not') ? 'bad' : 'ok'">
            {{ r.planned }} <span v-if="lockedNow(r.job)" class="tag">🔒 Dan</span>
          </div>
        </div>
        <button @click="openEdit(r.job)">Move / Lock</button>
      </div>
    </section>

    <!-- Needs a human -->
    <section v-if="tab === 'human'" class="list">
      <p v-if="!data?.needsHuman.length" class="muted">Nothing needs a human.</p>
      <div v-for="(n, i) in data?.needsHuman ?? []" :key="i" class="row">
        <div class="grow">
          <span class="tag">{{ n.type }}</span> <strong>{{ s(n.job) }}</strong>
          <div class="small">{{ n.reason }}</div>
        </div>
        <button v-if="/^\d+$/.test(s(n.job))" @click="openEdit(n.job)">Place it</button>
      </div>
    </section>

    <!-- Move / Lock panel -->
    <div v-if="editing" class="sheet" @click.self="editing = null">
      <form class="panel" @submit.prevent="save('move')">
        <h2>{{ editing.title }}</h2>
        <p v-if="editing.current" class="small muted">Now: {{ dayLabel(s(editing.current.day)) }}, crew {{ editing.current.crew }}</p>
        <p v-else class="small muted">Not in the plan yet.</p>
        <p v-if="editing.dropped" class="banner small">
          Move to <b>{{ dayLabel(form.day) }}</b>, <b>{{ form.crew === 'A+B' ? 'both crews' : 'Crew ' + form.crew }}</b>? Press <b>Save move</b> to confirm.
        </p>

        <button v-if="editing.current && !editing.dropped" type="button" :disabled="saving || !passcode" @click="save('lock')">🔒 Lock where it is</button>

        <label>Move to day
          <select v-model="form.day">
            <option v-for="d in workDays" :key="d" :value="d">{{ dayLabel(d) }}</option>
          </select>
        </label>
        <label>Crew
          <select v-model="form.crew" :disabled="editing.techs > 2">
            <option value="A">Crew A</option>
            <option value="B">Crew B</option>
            <option value="A+B">Both crews</option>
          </select>
        </label>
        <p v-if="editing.techs > 2" class="small muted">Needs {{ editing.techs }} technicians, so both crews.</p>

        <label>Passcode
          <input v-model="passcode" type="password" autocomplete="current-password" required />
        </label>

        <div class="actions">
          <button type="submit" class="primary" :disabled="saving || !passcode">Save move</button>
          <button v-if="lockedNow(editing.job)" type="button" :disabled="saving || !passcode" @click="save('unlock')">Unlock</button>
          <button type="button" @click="editing = null">Close</button>
        </div>
        <p v-if="message" class="small" :class="/Saved|Unlocked/.test(message) ? 'ok' : 'bad'">{{ message }}</p>
        <p class="small muted">Changes go to the Overrides tab. The plan updates when the workflow runs again.</p>
      </form>
    </div>
  </div>
</template>

<style>
:root { --bg: #f6f7f9; --card: #fff; --ink: #1d232b; --muted: #66717f; --line: #dde1e6; --ok: #1a7f37; --bad: #b42318; --accent: #0b5cad; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
.page { max-width: 1200px; margin: 0 auto; padding: 16px; }
header { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; align-items: flex-start; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 0 0 8px; }
h3 { font-size: 13px; margin: 0 0 6px; }
.muted { color: var(--muted); }
.small { font-size: 13px; display: block; }
.ok { color: var(--ok); }
.bad { color: var(--bad); }
button, select, input, a { font: inherit; }
button, .actions a { border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 8px 12px; cursor: pointer; color: var(--ink); text-decoration: none; }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.banner { background: #fff8e1; border: 1px solid #f0d58a; border-radius: 8px; padding: 10px 12px; }
.banner.bad { background: #fdecea; border-color: #f3b8b2; }
nav { position: sticky; top: 0; z-index: 5; background: var(--bg); padding: 10px 0; margin: 6px 0 10px; display: grid; gap: 8px; }
.tabs { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.tabs button { white-space: nowrap; flex: 0 0 auto; }
.tabs button b { font-weight: 600; margin-left: 2px; }
.tabs button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
.crewpick button { padding: 5px 10px; font-size: 13px; border-radius: 999px; }
.crewpick button.on { background: var(--accent); border-color: var(--accent); }
.loading { display: grid; justify-items: center; gap: 10px; padding: 48px 16px; color: var(--muted); text-align: center; }
.spinner { width: 28px; height: 28px; border: 3px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.crew-A { --c: #0b5cad; }
.crew-B { --c: #1a7f37; }
.crew-AB { --c: #7a3fb0; }
.chip { display: inline-block; font-style: normal; font-size: 11px; font-weight: 600; color: #fff; background: var(--c, var(--muted)); border-radius: 4px; padding: 0 5px; margin-right: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; }
.cal { display: grid; gap: 18px; }
.week h2 { margin-bottom: 6px; }
.weekgrid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.cell { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px; min-height: 130px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.cell h3 { font-size: 13px; margin: 0 0 2px; }
.cell.off { background: repeating-linear-gradient(45deg, #f1f2f4, #f1f2f4 6px, #e7e9ec 6px, #e7e9ec 12px); }
.cell.out { opacity: 0.55; }
.job { display: block; width: 100%; text-align: left; background: #f9fbff; padding: 6px 8px; border-left: 4px solid var(--c, var(--line)); }
.job .reason { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.lane { display: grid; gap: 4px; min-height: 30px; border-radius: 8px; }
.lane.drop { outline: 2px dashed var(--c); outline-offset: 2px; background: #f3f8ff; }
.job[draggable='true'] { cursor: grab; }
.ghost { margin: 0; border: 1px dashed var(--c); border-radius: 6px; padding: 4px 8px; color: var(--c); }
.free { margin: 0; color: var(--muted); border: 1px dashed var(--line); border-radius: 6px; padding: 4px 8px; }
.tag { display: inline-block; font-size: 12px; background: #eef2f7; border-radius: 6px; padding: 1px 6px; }
.list { display: grid; gap: 8px; }
.row { display: flex; gap: 12px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.rank { font-weight: 700; width: 28px; text-align: right; }
.grow { flex: 1; min-width: 0; }
.sheet { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: flex-end; justify-content: center; }
.panel { background: var(--card); width: 100%; max-width: 480px; border-radius: 14px 14px 0 0; padding: 16px; display: grid; gap: 10px; max-height: 90vh; overflow: auto; }
label { display: grid; gap: 4px; font-size: 13px; }
select, input { padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
@media (max-width: 640px) {
  .page { padding: 12px; }
  h1 { font-size: 18px; }
  header { gap: 8px; }
  header .actions button, header .actions a { padding: 6px 10px; font-size: 14px; }
  .row { flex-wrap: wrap; }
  .row > button { width: 100%; }
}
/* Narrow screens: a week becomes a sideways swipe, one or two days at a time */
@media (max-width: 900px) {
  .weekgrid { grid-template-columns: none; grid-auto-flow: column; grid-auto-columns: 46%; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 4px; }
  .cell { scroll-snap-align: start; }
}
@media (max-width: 640px) { .weekgrid { grid-auto-columns: 86%; } }
@media (min-width: 641px) { .sheet { align-items: center; } .panel { border-radius: 14px; } }
</style>
