<script setup lang="ts">
import { useForm } from 'vee-validate'
import type { PlanData, PlanRow, OverrideRow } from '../shared/types'

const config = useRuntimeConfig()
// First load may come from Vercel's edge cache (fast). Refresh / after a save asks for fresh data.
const fresh = ref(0)
const { data, pending, error } = useFetch<PlanData>('/api/plan', {
  server: false,
  query: computed(() => (fresh.value ? { fresh: fresh.value } : {})),
})
const reloadFresh = () => { fresh.value = Date.now() }

// Console trace of the whole flow (load → drag → drop → panel → checks → save → re-plan).
// Open DevTools → Console and filter on "[sf]". Never logs the passcode.
const log = (...a: unknown[]) => console.log('%c[sf]', 'color:#0b5cad;font-weight:bold', ...a)
watch(data, (d) => {
  if (!d) return
  const r = d.runs?.at(-1)
  log('plan loaded', { lastRun: r?.run_at, checks: r?.ok, placements: d.plan?.length, overrides: d.overrides?.length, needsHuman: d.needsHuman?.length })
})
watch(error, (e) => { if (e) log('plan load FAILED', e.statusCode, e.statusMessage || e.message) })

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

// VIC school holidays from Settings ("2026-09-21..2026-10-02;2026-12-19..2027-01-26")
const schoolHols = computed(() =>
  (settings.value.school_holidays || '').split(';').map((r) => r.split('..').map((x) => x.trim())).filter((r) => r[0] && r[1]),
)
const isSchoolHoliday = (iso: string) => schoolHols.value.some(([a, b]) => iso >= a! && iso <= b!)
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// ---- "Upcoming holidays" dropdown: public holidays + school breaks from Settings, from today on ----
const holidayName = (iso: string) => {
  const md = iso.slice(5)
  const d = new Date(iso + 'T00:00:00Z')
  if (md === '12-25') return 'Christmas Day'
  if (md === '12-26' || (md === '12-28' && d.getUTCDay() === 1)) return 'Boxing Day'
  if (md === '01-01') return "New Year's Day"
  if (md === '01-26') return 'Australia Day'
  if (d.getUTCMonth() === 10 && d.getUTCDay() === 2 && d.getUTCDate() <= 7) return 'Melbourne Cup Day'
  return 'Public holiday'
}
// VIC school breaks by the month they start in
const schoolBreakName = (start: string) => {
  const m = Number(start.slice(5, 7))
  if (m === 12 || m === 1) return 'Summer school holidays (end of Term 4)'
  if (m === 3 || m === 4) return 'Term 1 school holidays (Easter)'
  if (m === 6 || m === 7) return 'Term 2 school holidays (winter)'
  if (m === 9 || m === 10) return 'Term 3 school holidays (spring)'
  return 'VIC school holidays'
}
const daysBetween =(a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)
const upcoming = computed(() => {
  const today = settings.value.today || new Date().toISOString().slice(0, 10)
  const short = (iso: string) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const items = [
    ...schoolHols.value.map(([a, b]) => ({ kind: 'school', start: a!, end: b!, name: schoolBreakName(a!), when: `${short(a!)} – ${short(b!)}` })),
    ...[...holidays.value].map((d) => ({ kind: 'public', start: d, end: d, name: holidayName(d), when: short(d) })),
  ]
  return items
    .filter((h) => h.end >= today)
    .sort((x, y) => x.start.localeCompare(y.start))
    .map((h) => {
      const n = daysBetween(today, h.start)
      return { ...h, soon: n <= 0 ? 'now' : n === 1 ? 'tomorrow' : `in ${n} days`, inPlan: workDays.value.length > 0 && h.start <= workDays.value.at(-1)! && h.end >= workDays.value[0]! }
    })
})

// ---- calendar: Mon–Fri columns, one row per week that the plan touches ----
const weeks = computed(() => {
  const days = workDays.value
  if (!days.length) return []
  const monday = new Date(days[0] + 'T00:00:00Z')
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const out: { label: string; days: { iso: string; work: boolean; holiday: boolean; school: boolean }[] }[] = []
  for (; monday.toISOString().slice(0, 10) <= days.at(-1)!; monday.setUTCDate(monday.getUTCDate() + 7)) {
    const cells = Array.from({ length: 5 }, (_, i) => {
      const iso = addDays(monday.toISOString().slice(0, 10), i)
      return { iso, work: days.includes(iso), holiday: holidays.value.has(iso), school: isSchoolHoliday(iso) }
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
  const p = data.value?.plan.find((x) => s(x.job) === s(job))
  log('drag start', { job: s(job), from: p ? `${s(p.day)} crew ${s(p.crew)}` : 'not planned' })
}
// While dragging: does the job fit in this lane next to Dan's other changes? (red outline if not)
const dropOk = ref(true)
function fitsLane(job: string, day: string, crew: string) {
  const r = data.value?.ranked.find((x) => s(x.job) === job)
  const days = Number(r?.days) || 1
  const crews = Number(r?.techs) > 2 ? ['A', 'B'] : [crew]
  const i = workDays.value.indexOf(day)
  const n = Math.max(1, Math.ceil(days))
  if (i < 0 || i + n > workDays.value.length) return false
  return workDays.value.slice(i, i + n).every((d) =>
    crews.every((c) => [...dansOtherJobs(d, c, job).values()].reduce((a, b) => a + b, 0) + jobLoad(days) <= 1 + 1e-9))
}
function overLane(day: string, crew: string) {
  if (dropAt.value !== day + crew) {
    dropOk.value = fitsLane(dragJob.value, day, crew)
    log('drag over', { day, crew, fits: dropOk.value })
  }
  dropAt.value = day + crew
}
function endDrag(e?: DragEvent) {
  // dropOn() clears dragJob first, so a job still set here means the drop never happened
  if (e && dragJob.value) log('drag end – NOT dropped: released outside a crew lane', { job: dragJob.value })
  else if (e) log('drag end (dropped)')
  dragJob.value = ''
  dropAt.value = ''
}
function leaveLane(e: DragEvent) {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) dropAt.value = ''
}
function dropOn(day: string, crew: string) {
  const job = dragJob.value
  log('drop', { job: job || '(none – drag did not start on a job card)', day, crew })
  endDrag()
  if (!job) return
  openEdit(job)
  if (!editing.value) return
  setFieldValue('day', day)
  if (editing.value.techs <= 2) setFieldValue('crew', crew)
  editing.value.dropped = true
  // after the form reset has settled, so the reason shows in the panel straight away
  nextTick(() => validateField('day').then((r) => log('drop target check', r.valid ? 'OK' : r.errors.join(' '))))
}

// ---- after a save the web API re-runs the planner (~1 min): watch for the new run, then show it ----
// Fresh reads cost ~14 Google Sheets reads (quota 60/min), so check every 30 s, at most 6 times.
const replanning = ref(false)
const justUpdated = ref(false)
let runBefore = ''
let replanTimer: ReturnType<typeof setInterval> | undefined
function startReplanWatch() {
  runBefore = s(lastRun.value?.run_at)
  replanning.value = true
  justUpdated.value = false
  let tries = 0
  log('re-plan started; waiting for a run newer than', runBefore)
  clearInterval(replanTimer)
  replanTimer = setInterval(() => {
    if (++tries > 6) { clearInterval(replanTimer); replanning.value = false; log('re-plan not seen after 3 min – press Refresh'); return }
    log(`re-plan check ${tries}/6`)
    reloadFresh()
  }, 30000)
}
watch(lastRun, (r) => {
  if (replanning.value && s(r?.run_at) && s(r?.run_at) !== runBefore) {
    log('re-plan done', { run: s(r?.run_at), checks: s(r?.ok) })
    clearInterval(replanTimer)
    replanning.value = false
    justUpdated.value = true
    setTimeout(() => { justUpdated.value = false }, 8000)
  }
})
onBeforeUnmount(() => clearInterval(replanTimer))

// ---- Move / Lock panel ----
const editing = ref<{ job: string; title: string; techs: number; days: number; current?: PlanRow; dropped?: boolean } | null>(null)
const saving = ref(false)
const message = ref('')

// The same "can it physically go there?" checks the planner makes (engine.js planJobs), so Dan sees the
// problem before saving instead of in "Needs a human" after the next run. A job of N days takes N work
// days in a row (weekends and public holidays are skipped, like the planner does).
// Dan's changes are placed first and the planner works around them, so a crew-day only has room
// for what Dan's OTHER changes leave free (planned "Dan" rows + saved moves not run yet).
const jobLoad = (days: number) => (days >= 1 ? 1 : days)
function dansOtherJobs(day: string, crew: string, exceptJob: string) {
  const out = new Map<string, number>()
  for (const p of data.value?.plan ?? [])
    if (s(p.day) === day && s(p.crew).split('+').includes(crew) && s(p.source).startsWith('Dan') && s(p.job) !== exceptJob)
      out.set(s(p.job), jobLoad(Number(p.days) || 1))
  for (const o of pendingChanges.value)
    if (s(o.action) === 'move' && s(o.day) === day && s(o.crew).split('+').includes(crew) && s(o.job) !== exceptJob) {
      const r = data.value?.ranked.find((x) => s(x.job) === s(o.job))
      out.set(s(o.job), jobLoad(Number(r?.days) || 1))
    }
  return out
}

const { defineField, errors, handleSubmit, validateField, resetForm, setFieldValue, setFieldError } = useForm({
  validationSchema: {
    day: (v: string, ctx: { form: Record<string, unknown> }) => {
      const i = workDays.value.indexOf(v)
      if (i < 0) return 'Pick a work day in the plan.'
      const n = Math.max(1, Math.ceil(editing.value?.days || 1))
      if (i + n > workDays.value.length)
        return `This job takes ${n} work days, so it can't start on ${dayLabel(v)}: the plan ends on ${dayLabel(workDays.value.at(-1)!)}.`
      // room left on each day the job would use, for each crew it needs
      const need = jobLoad(editing.value?.days || 1)
      for (const d of workDays.value.slice(i, i + n))
        for (const c of String(ctx.form.crew || 'A').split('+')) {
          const others = dansOtherJobs(d, c, editing.value?.job || '')
          const used = [...others.values()].reduce((a, b) => a + b, 0)
          if (used + need > 1 + 1e-9) {
            const list = [...others].map(([j, l]) => `${j} (${l === 1 ? '1 day' : l + ' day'})`).join(', ')
            return `Crew ${c} is already full on ${dayLabel(d)} with your change ${list}. Pick another day or crew, or unlock ${[...others.keys()][0]} first.`
          }
        }
      return true
    },
    crew: (v: string) => {
      if (!['A', 'B', 'A+B'].includes(v)) return 'Pick a crew.'
      if ((editing.value?.techs ?? 2) > 2 && v !== 'A+B') return `Needs ${editing.value?.techs} technicians, so both crews.`
      return true
    },
    passcode: (v: string) => (v?.trim() ? true : 'Type the passcode to save.'),
  },
  initialValues: { day: '', crew: 'A', passcode: '' },
})
const [day] = defineField('day')
const [crew] = defineField('crew')
watch(crew, () => { if (editing.value && day.value) validateField('day') }) // room depends on the crew too
const [passcode] = defineField('passcode')
const passLocked = ref(true) // read-only until focused, so no autofill
// An old version remembered the passcode on the device; forget it.
onMounted(() => { try { localStorage.removeItem('sf-passcode') } catch {} })

function openEdit(job: unknown) {
  const id = s(job)
  const r = data.value?.ranked.find((x) => s(x.job) === id)
  const current = data.value?.plan.find((p) => s(p.job) === id)
  const techs = Number(r?.techs ?? current?.techs ?? 2)
  const days = Number(r?.days ?? current?.days ?? 1)
  editing.value = { job: id, title: `${id} · ${org(r?.organisation || current?.organisation, id)}`, techs, days, current }
  // Fresh form each time: passcode always starts empty.
  resetForm({ values: { crew: techs > 2 ? 'A+B' : s(current?.crew) || 'A', day: s(current?.day) || workDays.value[0] || '', passcode: '' } })
  passLocked.value = true
  message.value = ''
  log('panel open', { job: id, techs, days, now: current ? `${s(current.day)} crew ${s(current.crew)} (${s(current.source)})` : 'not planned', replanning: replanning.value })
}
function closeEdit() {
  editing.value = null
  resetForm({ values: { day: '', crew: 'A', passcode: '' } })
  passLocked.value = true
}

async function save(action: 'lock' | 'move' | 'unlock') {
  if (!editing.value) return
  saving.value = true
  message.value = ''
  try {
    const body =
      action === 'lock' && editing.value.current
        ? { job: editing.value.job, action, crew: s(editing.value.current.crew), day: s(editing.value.current.day) }
        : { job: editing.value.job, action, crew: crew.value, day: day.value }
    log('save →', body)
    const res = await $fetch('/api/override', { method: 'POST', body: { ...body, passcode: passcode.value } })
    log('save ✓', res)
    message.value = (action === 'unlock' ? 'Unlocked.' : 'Saved.') + ' Re-planning now – the calendar updates by itself in about a minute.'
    reloadFresh()
    startReplanWatch()
  } catch (e: any) {
    log('save ✗', e?.statusCode, e?.statusMessage || e?.data?.statusMessage || e?.message)
    if (e?.statusCode === 401) setFieldError('passcode', 'Wrong passcode.')
    else message.value = e?.statusMessage || e?.data?.statusMessage || 'Could not save.'
  } finally {
    saving.value = false
  }
}
// Move checks every field; Lock and Unlock only need the passcode (they don't use the day/crew boxes).
const submitMove = handleSubmit(
  () => save('move'),
  ({ errors: e }) => log('save blocked by form checks', e),
)
async function saveWithPasscode(action: 'lock' | 'unlock') {
  const r = await validateField('passcode')
  if (r.valid) await save(action)
  else log(`${action} blocked by form checks`, r.errors)
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
        <p class="muted version">Page version {{ config.public.buildTime }}</p>
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
    <p v-if="replanning" class="banner replan">
      <span class="spinner small-spin" /> Saved. Updating the plan with your change… the calendar refreshes by itself in about a minute.
    </p>
    <p v-else-if="justUpdated" class="banner done">✓ Plan updated with your change.</p>
    <p v-else-if="pendingChanges.length" class="banner">
      {{ pendingChanges.length }} change(s) saved but not in the plan yet:
      {{ pendingChanges.map((o) => `${s(o.job)} ${s(o.action)}`).join(', ') }} — press Refresh in a minute.
    </p>

    <nav v-if="data">
      <div class="tabs">
        <button :class="{ on: tab === 'plan' }" @click="tab = 'plan'">Plan</button>
        <button :class="{ on: tab === 'ranked' }" @click="tab = 'ranked'">Ranked <b>{{ data.ranked.length }}</b></button>
        <button :class="{ on: tab === 'human' }" @click="tab = 'human'">Needs a human <b>{{ data.needsHuman.length }}</b></button>
      </div>
      <div v-if="tab === 'plan'" class="navrow">
      <div class="tabs crewpick" aria-label="Calendar view and crew">
        <button :class="{ on: crewFilter === 'all' }" @click="crewFilter = 'all'">Both crews</button>
        <button :class="{ on: crewFilter === 'A' }" @click="crewFilter = 'A'">Crew A</button>
        <button :class="{ on: crewFilter === 'B' }" @click="crewFilter = 'B'">Crew B</button>
      </div>
      <!-- Upcoming VIC public holidays and school breaks (from Settings) -->
      <details class="holmenu">
        <summary>Upcoming holidays <b>{{ upcoming.length }}</b></summary>
        <ul>
          <li v-if="!upcoming.length" class="small muted">None listed in the Settings tab.</li>
          <li v-for="h in upcoming" :key="h.kind + h.start" class="hol">
            <i class="swatch" :class="h.kind === 'school' ? 'school' : 'off'" />
            <span class="grow">
              <strong>{{ h.name }}</strong>
              <span class="small muted">{{ h.when }}</span>
            </span>
            <span class="when" :class="{ inplan: h.inPlan }">{{ h.inPlan ? 'in this plan' : h.soon }}</span>
          </li>
          <li class="small muted hint">Dates come from the Settings tab (public_holidays, school_holidays).</li>
        </ul>
      </details>
      </div>
    </nav>

    <!-- Calendar: weeks as rows, Mon–Fri as columns (on a phone, swipe sideways through the days) -->
    <section v-if="tab === 'plan' && data" class="cal">
      <p class="legend small">
        <span v-for="c in allCrews" :key="c.id" :class="crewClass(c.id)"><i class="chip">Crew {{ c.id }}</i> {{ c.name }}</span>
        <span class="crew-AB"><i class="chip">Both</i> 4-person job</span>
        <span><i class="swatch school" /> VIC school holidays</span>
        <span><i class="swatch off" /> Public holiday</span>
      </p>

      <div v-for="w in weeks" :key="w.label" class="week">
        <h2>{{ w.label }}</h2>
        <div class="weekgrid">
          <article v-for="c in w.days" :key="c.iso" class="cell" :class="{ off: c.holiday, out: !c.work && !c.holiday, school: c.school }">
            <h3>{{ dayLabel(c.iso) }}</h3>
            <span v-if="c.school" class="mtag">VIC school holidays</span>
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
              <div v-for="cr in crews" :key="cr.id" class="lane"
                :class="[crewClass(cr.id), { drop: dropAt === c.iso + cr.id, nodrop: dropAt === c.iso + cr.id && !dropOk }]"
                @dragover.prevent="overLane(c.iso, cr.id)" @dragleave="leaveLane" @drop.prevent="dropOn(c.iso, cr.id)">
                <button v-for="p in laneJobs(c.iso, cr.id)" :key="s(p.job) + p.part" class="job" :class="crewClass(p.crew)" draggable="true"
                  @dragstart="startDrag($event, p.job)" @dragend="endDrag" @click="openEdit(p.job)">
                  <i class="chip">Crew {{ cr.id }}</i>
                  <strong>{{ s(p.job) }}</strong> {{ org(p.organisation, p.job) }}
                  <span class="small">{{ p.suburb }} · {{ s(p.days) }}d {{ p.part }}</span>
                  <span class="small muted reason">{{ p.reason }}</span>
                  <span v-if="s(p.source).startsWith('Dan')" class="tag">🔒 {{ p.source }}</span>
                </button>
                <p v-for="o in movingInto(c.iso, cr.id)" :key="s(o.job)" class="small ghost">↪ {{ s(o.job) }} will move here – updating the plan (about 1 min)</p>
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
    <div v-if="editing" class="sheet" @click.self="closeEdit">
      <form class="panel" novalidate @submit.prevent="submitMove">
        <h2>{{ editing.title }}</h2>
        <p v-if="editing.current" class="small muted">Now: {{ dayLabel(s(editing.current.day)) }}, crew {{ editing.current.crew }}</p>
        <p v-else class="small muted">Not in the plan yet · {{ editing.techs }} techs × {{ editing.days }} day(s)</p>
        <p v-if="editing.dropped && errors.day" class="banner bad small">Can't move it there: {{ errors.day }}</p>
        <p v-else-if="editing.dropped" class="banner small">
          Move to <b>{{ dayLabel(day) }}</b>, <b>{{ crew === 'A+B' ? 'both crews' : 'Crew ' + crew }}</b>? Press <b>Save move</b> to confirm.
        </p>

        <p v-if="replanning" class="banner small">The plan is still updating with your last change (about a minute). Make the next change after that.</p>
        <button v-if="editing.current && !editing.dropped" type="button" :disabled="saving || replanning" @click="saveWithPasscode('lock')">🔒 Lock where it is</button>

        <label>Move to day
          <select v-model="day" :class="{ invalid: errors.day }">
            <option v-for="d in workDays" :key="d" :value="d">{{ dayLabel(d) }}</option>
          </select>
          <span v-if="errors.day" class="small bad">{{ errors.day }}</span>
        </label>
        <label>Crew
          <select v-model="crew" :disabled="editing.techs > 2" :class="{ invalid: errors.crew }">
            <option value="A">Crew A</option>
            <option value="B">Crew B</option>
            <option value="A+B">Both crews</option>
          </select>
          <span v-if="errors.crew" class="small bad">{{ errors.crew }}</span>
          <span v-else-if="editing.techs > 2" class="small muted">Needs {{ editing.techs }} technicians, so both crews.</span>
        </label>

        <label>Passcode
          <!-- Not type="password": password managers only fill password fields, so Chrome can't refill it.
               The dots come from CSS (-webkit-text-security). Read-only until tapped as a second guard. -->
          <input v-model="passcode" type="text" class="secret" name="sf-move-code" autocomplete="off" autocapitalize="off"
            spellcheck="false" inputmode="text" data-lpignore="true" data-1p-ignore data-bwignore
            :readonly="passLocked" @focus="passLocked = false" :class="{ invalid: errors.passcode }" />
          <span v-if="errors.passcode" class="small bad">{{ errors.passcode }}</span>
        </label>

        <div class="actions">
          <button type="submit" class="primary" :disabled="saving || replanning">Save move</button>
          <button v-if="lockedNow(editing.job)" type="button" :disabled="saving || replanning" @click="saveWithPasscode('unlock')">Unlock</button>
          <button type="button" @click="closeEdit">Close</button>
        </div>
        <p v-if="message" class="small" :class="/Saved|Unlocked/.test(message) ? 'ok' : 'bad'">{{ message }}</p>
        <p class="small muted">Changes go to the Overrides tab, and the plan is re-made straight away (about a minute).</p>
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
.banner.replan { display: flex; align-items: center; gap: 10px; background: #eef4fb; border-color: #b9d1ec; }
.banner.done { background: #e9f6ec; border-color: #a8d5b3; color: var(--ok); }
.banner .small-spin { width: 16px; height: 16px; border-width: 2px; flex: 0 0 auto; }
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
.navrow { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.navrow .crewpick { flex: 1 1 auto; min-width: 0; }
.holmenu { position: relative; flex: 0 0 auto; }
.holmenu summary { list-style: none; cursor: pointer; white-space: nowrap; font-size: 13px; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--bad); color: var(--bad); background: #fff5f4; }
.holmenu summary::-webkit-details-marker { display: none; }
.holmenu summary::after { content: ' ▾'; }
.holmenu[open] summary { background: var(--bad); color: #fff; }
.holmenu summary b { margin-left: 2px; }
.holmenu ul { position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; width: min(340px, calc(100vw - 32px)); margin: 0; padding: 6px; list-style: none; background: var(--card); border: 1px solid var(--line); border-top: 3px solid var(--bad); border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); display: grid; gap: 2px; }
.holmenu li.hol { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; }
.holmenu li.hol + li.hol { border-top: 1px solid var(--line); }
.holmenu .when { font-size: 12px; color: var(--bad); white-space: nowrap; }
.holmenu .when.inplan { font-weight: 600; }
.holmenu .hint { padding: 6px 8px 2px; }
.swatch { display: inline-block; width: 14px; height: 10px; border-radius: 3px; vertical-align: middle; border: 1px solid var(--line); }
.swatch.school, .cell.school { background: #fff3cc; border-color: #f0d58a; }
.swatch.off { background: repeating-linear-gradient(45deg, #f1f2f4, #f1f2f4 4px, #e2e5e9 4px, #e2e5e9 8px); }
.mtag { align-self: flex-start; max-width: 100%; font-size: 11px; line-height: 1.5; background: #f0d58a; color: #5c4300; border-radius: 4px; padding: 0 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Each crew lane stretches to fill the day, so the whole day is a drop target (top half A, bottom half B). */
.lane { flex: 1 0 auto; display: flex; flex-direction: column; gap: 4px; min-height: 48px; padding: 4px; border-radius: 8px;
  background: color-mix(in srgb, var(--c) 5%, transparent); border-left: 3px solid color-mix(in srgb, var(--c) 35%, transparent); }
.lane.drop { outline: 2px dashed var(--c); outline-offset: 2px; background: #f3f8ff; }
.lane.nodrop { outline-color: var(--bad); background: #fdecea; }
.job[draggable='true'] { cursor: grab; }
.ghost { margin: 0; border: 1px dashed var(--c); border-radius: 6px; padding: 4px 8px; color: var(--c); }
.free { margin: 0; color: var(--muted); border: 1px dashed var(--line); border-radius: 6px; padding: 4px 8px; }
.tag { display: inline-block; font-size: 12px; background: #eef2f7; border-radius: 6px; padding: 1px 6px; }
.list { display: grid; gap: 8px; }
.row { display: flex; gap: 12px; align-items: center; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.rank { font-weight: 700; width: 28px; text-align: right; }
.grow { flex: 1; min-width: 0; }
.sheet { position: fixed; inset: 0; z-index: 20; background: rgba(0, 0, 0, 0.35); display: flex; align-items: flex-end; justify-content: center; }
.panel { background: var(--card); width: 100%; max-width: 480px; border-radius: 14px 14px 0 0; padding: 16px; display: grid; gap: 10px; max-height: 90vh; overflow: auto; }
label { display: grid; gap: 4px; font-size: 13px; }
select, input { padding: 8px; border: 1px solid var(--line); border-radius: 8px; }
select.invalid, input.invalid { border-color: var(--bad); }
input.secret { -webkit-text-security: disc; text-security: disc; }
.version { font-size: 11px; margin: 0; }
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
@media (max-width: 640px) {
  .navrow .crewpick { flex-basis: 100%; }
  .holmenu ul { left: 0; right: auto; }
  .weekgrid { grid-auto-columns: 86%; }
}
@media (min-width: 641px) { .sheet { align-items: center; } .panel { border-radius: 14px; } }
</style>
