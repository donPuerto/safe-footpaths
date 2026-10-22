<script setup lang="ts">
import { useForm } from 'vee-validate'
import { VueDraggable, type DraggableEvent } from 'vue-draggable-plus'
import type { MoveEvent } from 'sortablejs'
import type { PlanData, PlanRow, OverrideRow } from '../shared/types'

const config = useRuntimeConfig()
// First load may come from Vercel's edge cache (fast). Refresh / after a save asks for fresh data.
// Always read fresh: a plan read is one Sheets call now, and a cached copy (up to 30 s old at the edge) right after
// a save would show the card back in its old place.
const fresh = ref(Date.now())
const { data, pending, error } = useFetch<PlanData>('/api/plan', {
  server: false,
  query: computed(() => (fresh.value ? { fresh: fresh.value } : {})),
})
const reloadFresh = () => { fresh.value = Date.now() }
// The Refresh button: start over completely (reload = newest deployed build, fresh data, no leftover client state).
const hardRefresh = () => { window.location.reload() }

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

const cell = (day: string, crew: string) => displayPlan.value.filter((p) => s(p.day) === day && s(p.crew).split('+').includes(crew))
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
// ---- what the calendar shows: the plan + Dan's moves the planner hasn't applied yet ----
// A moved card sits in its new place at once: while the panel is open ("not saved yet") and, after Save,
// straight away ("saved") – the planner re-plans the other jobs in the background.
// preview = the move set up in the open panel; justSaved = moves saved this second, until the fresh
// data (pendingChanges) carries them.
// days = Dan's length when he resized the job (replaces the Backlog estimate), else the estimate.
type Move = { day: string; crew: string; days?: number }
const preview = ref<({ job: string } & Move) | null>(null)
const justSaved = ref(new Map<string, Move>())
type CalRow = PlanRow & { moving?: 'unsaved' | 'saved' }
const displayPlan = computed<CalRow[]>(() => {
  const plan = data.value?.plan ?? []
  const moves = new Map<string, Move & { saved: boolean }>()
  for (const o of pendingChanges.value)
    if (s(o.action) === 'move' || s(o.action) === 'lock')
      moves.set(s(o.job), { day: s(o.day), crew: s(o.crew), days: Number(o.days) || undefined, saved: true })
  for (const [job, mv] of justSaved.value) moves.set(job, { ...mv, saved: true })
  if (preview.value) moves.set(preview.value.job, { ...preview.value, saved: false })
  const out: CalRow[] = plan.filter((p) => !moves.has(s(p.job)))
  for (const [job, mv] of moves) {
    const base = plan.find((p) => s(p.job) === job)
    const r = data.value?.ranked.find((x) => s(x.job) === job)
    const len = mv.days || Number(r?.days ?? base?.days) || 1
    const n = Math.max(1, Math.ceil(len))
    const i = workDays.value.indexOf(mv.day)
    if (i < 0) continue
    workDays.value.slice(i, i + n).forEach((d, k) =>
      out.push({
        ...(base as PlanRow), job, organisation: r?.organisation ?? base?.organisation ?? '', suburb: r?.suburb ?? base?.suburb ?? '',
        techs: r?.techs ?? base?.techs ?? 2, days: len, day: d, crew: mv.crew,
        part: n > 1 ? `day ${k + 1} of ${n}` : '', source: 'Dan (moving)', reason: '', moving: mv.saved ? 'saved' : 'unsaved',
      }))
  }
  return out
})
const firstDayOf = (job: string) => displayPlan.value.filter((x) => s(x.job) === job).map((x) => s(x.day)).sort()[0] || ''

// ---- resize (FullCalendar style): drag the right edge of a card or bar to make the job longer or shorter ----
// Whole days only; the bar grows/shrinks live, then the same confirm panel opens with the new length.
const resizing = ref<{ job: string; day: string; crew: string; days: number } | null>(null)
// The day column under the pointer, anywhere on the calendar (so a resize can cross into the next week row):
// the cell whose x-range holds the pointer, in the week row nearest to the pointer.
// Dragging past the right end of a week row continues into the next week's work days (Fri → Mon → …),
// past the left end goes back; a holiday cell snaps to the work day before it.
function dayUnderPointer(x: number, y: number) {
  const cells = [...document.querySelectorAll<HTMLElement>('.cal .cell[data-day]')].map((el) => ({ day: el.dataset.day!, r: el.getBoundingClientRect() }))
  if (!cells.length) return ''
  // the week row nearest to the pointer (cells sharing the same top)
  const rowDist = (r: DOMRect) => (y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0)
  const nearest = cells.reduce((a, c) => (rowDist(c.r) < rowDist(a.r) ? c : a))
  const row = cells.filter((c) => Math.abs(c.r.top - nearest.r.top) < 2).sort((a, b) => a.r.left - b.r.left)
  const colW = row[0]!.r.width + 6
  const wd = workDays.value
  // index in workDays of the last work day on/before a date
  const idxOf = (day: string) => { let i = -1; for (let k = 0; k < wd.length; k++) if (wd[k]! <= day) i = k; return i }
  const hit = row.find((c) => x >= c.r.left && x <= c.r.right)
  if (hit) return wd[Math.max(0, idxOf(hit.day))] || ''
  const first = row[0]!, last = row.at(-1)!
  if (x > last.r.right) return wd[Math.min(wd.length - 1, idxOf(last.day) + Math.ceil((x - last.r.right) / colW))] || ''
  if (x < first.r.left) return wd[Math.max(0, idxOf(first.day) - Math.ceil((first.r.left - x) / colW))] || ''
  return ''
}
function startResize(e: PointerEvent, p: CalRow, startDay: string) {
  e.preventDefault()
  e.stopPropagation()
  resizing.value = { job: s(p.job), day: startDay, crew: s(p.crew), days: Math.max(1, Math.ceil(Number(p.days) || 1)) }
  // Capture the pointer on the page body (it survives the card being re-rendered strip <-> lane) so the release
  // reaches us wherever it happens - over the bar, over another day, or outside the window.
  try { document.body.setPointerCapture(e.pointerId) } catch {}
  window.addEventListener('pointermove', moveResize)
  window.addEventListener('pointerup', endResize, { once: true })
  window.addEventListener('pointercancel', endResize, { once: true })
  window.addEventListener('blur', endResize, { once: true })
  log('resize start', { job: s(p.job), from: `${resizing.value.days} day(s)` })
}
function moveResize(e: PointerEvent) {
  const r = resizing.value
  if (!r) return
  // length = work days from the start day to the day under the pointer (weekends/holidays don't count)
  const under = dayUnderPointer(e.clientX, e.clientY)
  const i0 = workDays.value.indexOf(r.day)
  const i1 = workDays.value.indexOf(under)
  if (i0 < 0 || i1 < 0) return
  const n = Math.max(1, i1 - i0 + 1)
  if (n !== r.days) {
    r.days = n
    preview.value = { job: r.job, day: r.day, crew: r.crew, days: n }
    log('resize', { days: n })
  }
}
function endResize(e?: Event) {
  window.removeEventListener('pointermove', moveResize)
  window.removeEventListener('pointerup', endResize)
  window.removeEventListener('pointercancel', endResize)
  window.removeEventListener('blur', endResize)
  const r = resizing.value
  if (!r) return
  resizing.value = null
  dragEndedAt = Date.now()
  log('resize end', { job: r.job, days: r.days, via: e?.type || 'direct' })
  setTimeout(() => { rebuildLanes(); calKey.value++ }, 0) // redraw from data: no half-updated bars left behind
  openEdit(r.job)
  if (!editing.value) return
  setFieldValue('day', r.day)
  if (editing.value.techs <= 2) setFieldValue('crew', r.crew)
  setFieldValue('days', r.days)
  editing.value.dropped = true
  nextTick(() => validateField('day').then((res) => log('resize check', res.valid ? 'OK' : res.errors.join(' '))))
}

// ---- drag and drop: vue-draggable-plus (SortableJS) – the card itself slides; works with mouse and touch ----
// One list per day × lane ("A", "B", and "A+B" for 4-person jobs), rebuilt from displayPlan.
const laneKey = (day: string, crew: string) => `${day}|${crew}`
const lanes = ref<Record<string, CalRow[]>>({})
// Wide screens: multi-day jobs are ONE bar across their days (like FullCalendar), in a strip at the top of
// each week. Narrow screens (days scroll sideways): first-day card + "continued" bars inside the lanes.
const narrow = ref(false)
onMounted(() => {
  const mq = window.matchMedia('(max-width: 900px)')
  narrow.value = mq.matches
  mq.addEventListener('change', (e) => { narrow.value = e.matches })
})
const isMulti = (p: CalRow) => /^day \d+ of \d+/.test(s(p.part))
const mondayOf = (iso: string) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7))
type Seg = CalRow & { col: number; span: number; first: boolean; last: boolean }
const strips = ref<Record<string, Seg[]>>({}) // key "monday|crew"
function rebuildLanes() {
  const m: Record<string, CalRow[]> = {}
  for (const d of workDays.value) for (const c of ['A', 'B', 'A+B']) m[laneKey(d, c)] = []
  const st: Record<string, Seg[]> = {}
  const byJob = new Map<string, CalRow[]>()
  for (const p of displayPlan.value) {
    if (isMulti(p) && !narrow.value) {
      if (!byJob.has(s(p.job))) byJob.set(s(p.job), [])
      byJob.get(s(p.job))!.push(p)
    } else m[laneKey(s(p.day), s(p.crew))]?.push(p)
  }
  // one bar per run of side-by-side days in the same week (a weekend or holiday splits it)
  for (const rows of byJob.values()) {
    rows.sort((a, b) => s(a.day).localeCompare(s(b.day)))
    let seg: Seg | null = null
    let week = ''
    let lastCol = -9
    rows.forEach((p, i) => {
      const wk = mondayOf(s(p.day))
      const col = (new Date(s(p.day) + 'T00:00:00Z').getUTCDay() + 6) % 7
      if (seg && wk === week && col === lastCol + 1) seg.span++
      else {
        seg = { ...p, col, span: 1, first: i === 0, last: false }
        week = wk
        ;(st[`${wk}|${s(p.crew)}`] ||= []).push(seg)
      }
      lastCol = col
      if (i === rows.length - 1) seg.last = true
    })
  }
  lanes.value = m
  strips.value = st
}
watchEffect(rebuildLanes)
const stripKeys = (monday: string) =>
  ['A', 'B', 'A+B']
    .filter((c) => c === 'A+B' || crewFilter.value === 'all' || crewFilter.value === c)
    .map((c) => `${monday}|${c}`)
    .filter((k) => strips.value[k]?.length)
// A multi-day job is one job: the full card on its first day ("2 days: Fri 30 Oct → Mon 2 Nov"),
// a slim "continued" bar on the other days. Only the first-day card can be dragged.
const isContinued = (p: CalRow) => /^day ([2-9]|\d{2,})/.test(s(p.part))
const startDayOf = (p: CalRow) => {
  const first = displayPlan.value.filter((x) => s(x.job) === s(p.job)).map((x) => s(x.day)).sort()[0]
  return first ? dayLabel(first) : ''
}
const spanLabel = (p: CalRow) => {
  const days = displayPlan.value.filter((x) => s(x.job) === s(p.job)).map((x) => s(x.day)).sort()
  return days.length > 1 ? `${days.length} days: ${dayLabel(days[0]!)} → ${dayLabel(days.at(-1)!)}` : ''
}
const dragJob = ref('')
const calKey = ref(0) // bumped after every drag: the calendar re-renders from the data
// Room left in a crew's day, in plain words: "free", "½ day free", "¼ day free" – or '' when the day is full.
// Counts every job shown in the lane (a multi-day job takes the whole day).
const laneRoom = (day: string, crew: string) => {
  const used = cell(day, crew).reduce((a, p) => a + jobLoad(Number(p.days) || 1), 0)
  const left = Math.round((1 - used) * 4) / 4
  if (left <= 0) return 'full'
  if (left >= 1) return 'free'
  return `${({ 0.25: '¼', 0.5: '½', 0.75: '¾' } as Record<number, string>)[left] || left} day free`
}
// While dragging: can the dragged job go into this lane? (lanes that can are shown green, "Drop here")
const laneFits = (day: string, crew: string) => !!dragJob.value && !whyNotLane(dragJob.value, day, crew === 'A+B' ? 'A' : crew)
let lastOver = ''
function onDragStart(e: DraggableEvent<CalRow>) {
  dragJob.value = s(e.data?.job)
  lastOver = ''
  log('drag start', { job: dragJob.value, from: `${s(e.data?.day)} crew ${s(e.data?.crew)}` })
}
// The browser fires a click on the card right after a drag or resize ends; that must not re-open the panel
// (it would wipe the drop/resize prefill). Clicks within 600 ms of a drag end are ignored.
let dragEndedAt = 0
function onCardClick(job: unknown) {
  if (Date.now() - dragEndedAt < 600) { log('click ignored (just dragged)'); return }
  openEdit(job)
}
function onDragEnd(e: DraggableEvent<CalRow>) {
  dragEndedAt = Date.now()
  log(e.from === e.to ? 'drag end – put back where it was' : 'drag end (dropped)', blocked.value?.reason || '')
  dragJob.value = ''
  hoverLane.value = ''
  // SortableJS/VueDraggable update their lists after this event; a moment later, redraw the whole calendar
  // from the data (new render key) so no moved DOM node can be left behind
  setTimeout(() => { rebuildLanes(); calKey.value++ }, 0)
  // a refused drop snaps the card back; keep the reason on screen long enough to read it
  if (blocked.value) { const b = blocked.value; setTimeout(() => { if (blocked.value === b) blocked.value = null }, 8000) }
}
// SortableJS asks before showing the card in a lane: a lane it can't fit in refuses it (the card stays put),
// and the lane turns red with the reason, so a refused drop never looks like a broken page.
const blocked = ref<{ lane: string; reason: string } | null>(null)
const hoverLane = ref('') // the lane under the pointer while dragging (filled in its crew colour)
const toast = useToast()
// the refusal message is one toast (id "drop"): sticky while the card is held, 8 s after it was put back
watch([blocked, dragJob], ([b, dj]) => {
  if (!b) { toast.dismiss('drop'); return }
  toast.error(`${dj ? "Can't drop here" : 'Put back where it was'}: ${b.reason}`, { id: 'drop', timeout: dj ? 0 : 8000 })
})
function canMove(e: MoveEvent) {
  if ((e.to as HTMLElement).dataset.strip) return false // the long-bar strip only gives cards, never takes them
  const key = (e.to as HTMLElement).dataset.lane || ''
  hoverLane.value = key
  const [day = '', crew = ''] = key.split('|')
  const reason = day ? whyNotLane(dragJob.value, day, crew === 'A+B' ? 'A' : crew) : 'Not a day in the plan.'
  blocked.value = reason ? { lane: key, reason } : null
  if (lastOver !== key) { log('drag over', { day, crew, fits: !reason, reason }); lastOver = key }
  return !reason
}
const dragOptions = {
  group: 'jobs', sort: false, animation: 180, draggable: '.job:not(.cont)',
  filter: '.resize', preventOnFilter: false, // the resize handle resizes, it never starts a drag
  forceFallback: true, fallbackOnBody: true, fallbackTolerance: 4, // own drag image: solid card, also on touch screens
  ghostClass: 'drag-placeholder', chosenClass: 'drag-chosen', dragClass: 'drag-flying',
  onMove: canMove,
}
// strip of long bars: cards can be dragged out of it onto a day, nothing is dropped into it
const stripOptions = { ...dragOptions, group: { name: 'jobs', pull: true, put: false }, draggable: '.job' }
// '' when the job fits in that lane, otherwise the reason in plain words (same rules as the planner)
function whyNotLane(job: string, day: string, crew: string) {
  const r = data.value?.ranked.find((x) => s(x.job) === job)
  const days = Number(r?.days) || 1
  const crews = Number(r?.techs) > 2 ? ['A', 'B'] : [crew]
  const i = workDays.value.indexOf(day)
  const n = Math.max(1, Math.ceil(days))
  if (i < 0) return `${dayLabel(day)} is not a work day.`
  if (i + n > workDays.value.length)
    return `${job} takes ${n} work days – it can't start ${dayLabel(day)}: the plan ends ${dayLabel(workDays.value.at(-1)!)}.`
  for (const d of workDays.value.slice(i, i + n))
    for (const c of crews) {
      const others = dansOtherJobs(d, c, job)
      if ([...others.values()].reduce((a, b) => a + b, 0) + jobLoad(days) > 1 + 1e-9)
        return `${job} needs ${n} day${n === 1 ? '' : 's'} (${workDays.value.slice(i, i + n).map(dayLabel).join(' + ')}), but crew ${c} is full on ${dayLabel(d)} with ${[...others.keys()].join(', ')}. Move ${[...others.keys()][0]} first or pick another day.`
    }
  return ''
}
// Dropped into another lane: open the confirm panel with that day and crew (the card is already there).
function onDrop(e: DraggableEvent<CalRow>, day: string, crew: string) {
  const job = s(e.data?.job)
  // SortableJS keeps the card in the last lane that accepted it; if the pointer was over a refused
  // (red) lane when Dan let go, cancel instead of dropping somewhere he didn't aim at.
  if (blocked.value) {
    log('drop cancelled – let go over a lane the job cannot go to', blocked.value.reason)
    rebuildLanes()
    return
  }
  log('drop', { job, day, crew })
  if (!job) return
  openEdit(job)
  if (!editing.value) return
  setFieldValue('day', day)
  if (editing.value.techs <= 2) setFieldValue('crew', crew)
  editing.value.dropped = true
  // after the form reset has settled, so the reason shows in the panel straight away; then put every card back
  // where the data says (SortableJS moved the DOM node, the preview now carries the move)
  nextTick(() => { rebuildLanes(); validateField('day').then((r) => log('drop target check', r.valid ? 'OK' : r.errors.join(' '))) })
}

// ---- after a save the web API re-runs the planner (~20 s): watch for the new run, then show it ----
// A fresh read is one Google Sheets call (batchGet), so checking every 10 s for up to 3 min is cheap.
// Changes saved WHILE a run is going are saved with replan:false and queued; when that run ends the
// page starts ONE more run for all of them – runs never overlap, and Dan never waits to save.
const replanning = ref(false)
const queued = ref(0) // changes saved during the current run, waiting for the next one
const justUpdated = ref(false)
let sessionPasscode = '' // kept in memory only (never stored or shown) so the page can start the queued run
let runBefore = ''
let replanTimer: ReturnType<typeof setInterval> | undefined
async function runQueued() {
  const n = queued.value
  queued.value = 0
  log(`starting one more update for ${n} queued change(s)`)
  try {
    await $fetch('/api/override', { method: 'POST', body: { action: 'replan', passcode: sessionPasscode } })
    startReplanWatch()
  } catch (e: any) {
    log('queued update could not start', e?.statusCode, e?.statusMessage)
    queued.value = n // keep them; the banner says to press Refresh / save again
  }
}
// "Update the plan now" in the pending banner: uses the passcode from this tab's last save, else asks for it.
const needPass = ref(false)
const passNow = ref('')
const updating = ref(false)
const updateError = ref('')
async function updateNow() {
  const code = sessionPasscode || passNow.value.trim()
  if (!code) { needPass.value = true; return }
  updating.value = true
  updateError.value = ''
  try {
    await $fetch('/api/override', { method: 'POST', body: { action: 'replan', passcode: code } })
    sessionPasscode = code
    passNow.value = ''
    needPass.value = false
    log('update started from the banner')
    startReplanWatch()
  } catch (e: any) {
    updateError.value = e?.statusCode === 401 ? 'Wrong passcode.' : 'Could not start the update.'
    needPass.value = true
    log('banner update failed', e?.statusCode)
  } finally {
    updating.value = false
  }
}
function startReplanWatch() {
  runBefore = s(lastRun.value?.run_at)
  replanning.value = true
  justUpdated.value = false
  let tries = 0
  log('re-plan started; waiting for a run newer than', runBefore)
  clearInterval(replanTimer)
  replanTimer = setInterval(() => {
    if (++tries > 18) { clearInterval(replanTimer); replanning.value = false; log('re-plan not seen after 3 min – press Refresh'); return }
    log(`re-plan check ${tries}/18`)
    reloadFresh()
  }, 10000)
}
watch(lastRun, (r) => {
  if (replanning.value && s(r?.run_at) && s(r?.run_at) !== runBefore) {
    log('re-plan done', { run: s(r?.run_at), checks: s(r?.ok) })
    clearInterval(replanTimer)
    replanning.value = false
    if (queued.value) { runQueued(); return } // changes came in during that run: one more, for all of them
    justUpdated.value = true
    toast.success('Plan updated with your changes.', { id: 'updated', timeout: 6000 })
    setTimeout(() => { justUpdated.value = false }, 8000)
  }
})
// once fresh data carries a saved move (as a pending change or already in the plan), stop bridging it
watch(data, () => {
  for (const [job, mv] of justSaved.value) {
    const inPending = pendingChanges.value.some((o) => s(o.job) === job)
    const inPlan = (data.value?.plan ?? []).some((p) => s(p.job) === job && s(p.day) === mv.day && s(p.crew) === mv.crew)
    if (inPending || inPlan) justSaved.value.delete(job)
  }
})
onBeforeUnmount(() => clearInterval(replanTimer))

// ---- Move / Lock panel ----
// days = the Backlog estimate; nowDays = the length the job has in the plan right now (Dan may have resized it)
const editing = ref<{ job: string; title: string; techs: number; days: number; nowDays: number; current?: PlanRow; dropped?: boolean } | null>(null)
const saving = ref(false)
const message = ref('')

// The same "can it physically go there?" checks the planner makes (engine.js planJobs), so Dan sees the
// problem before saving instead of in "Needs a human" after the next run. A job of N days takes N work
// days in a row (weekends and public holidays are skipped, like the planner does).
// A crew-day has room for what the jobs shown in it leave free – every job counts (the lane label says the same),
// so "full" on the page means "can't drop here". (The planner itself would move its own placements around a
// Dan change, but that was confusing: a lane read "full" and still accepted a drop.)
const jobLoad = (days: number) => (days >= 1 ? 1 : days)
function dansOtherJobs(day: string, crew: string, exceptJob: string) {
  const out = new Map<string, number>()
  for (const p of displayPlan.value)
    if (s(p.day) === day && s(p.crew).split('+').includes(crew) && s(p.job) !== exceptJob)
      out.set(s(p.job), jobLoad(Number(p.days) || 1))
  return out
}

const { defineField, errors, handleSubmit, validateField, resetForm, setFieldValue, setFieldError } = useForm({
  validationSchema: {
    day: (v: string, ctx: { form: Record<string, unknown> }) => {
      const i = workDays.value.indexOf(v)
      if (i < 0) return 'Pick a work day in the plan.'
      const len = Number(ctx.form.days) || editing.value?.days || 1
      const n = Math.max(1, Math.ceil(len))
      if (i + n > workDays.value.length)
        return `This job takes ${n} work days, so it can't start on ${dayLabel(v)}: the plan ends on ${dayLabel(workDays.value.at(-1)!)}.`
      // room left on each day the job would use, for each crew it needs
      const need = jobLoad(len)
      for (const d of workDays.value.slice(i, i + n))
        for (const c of String(ctx.form.crew || 'A').split('+')) {
          const others = dansOtherJobs(d, c, editing.value?.job || '')
          const used = [...others.values()].reduce((a, b) => a + b, 0)
          if (used + need > 1 + 1e-9) {
            const list = [...others].map(([j, l]) => `${j} (${l === 1 ? '1 day' : l + ' day'})`).join(', ')
            return `Crew ${c} is full on ${dayLabel(d)} with ${list}. Pick another day or crew, or move ${[...others.keys()][0]} first.`
          }
        }
      return true
    },
    crew: (v: string) => {
      if (!['A', 'B', 'A+B'].includes(v)) return 'Pick a crew.'
      if ((editing.value?.techs ?? 2) > 2 && v !== 'A+B') return `Needs ${editing.value?.techs} technicians, so both crews.`
      return true
    },
    days: (v: unknown) => (Number(v) > 0 && Number(v) <= 10 ? true : 'Pick a length between a quarter day and 10 days.'),
    passcode: (v: string) => (v?.trim() ? true : 'Type the passcode to save.'),
  },
  initialValues: { day: '', crew: 'A', days: 1, passcode: '' },
})
const [day] = defineField('day')
const [crew] = defineField('crew')
const [days] = defineField('days')
const dayOptions = [0.25, 0.5, 1, 2, 3, 4, 5]
const lengthOptions = computed(() => [...new Set([...dayOptions, editing.value?.days || 1])].sort((a, b) => a - b))
watch([crew, days], () => { if (editing.value && day.value) validateField('day') }) // room depends on the crew and length too
// Live preview: while the panel is open, the card shows in the day/crew/length picked (dropped, resized or chosen).
watch([day, crew, days, editing], () => {
  const ed = editing.value
  if (!ed) return
  const cur = ed.current
  const len = Number(days.value) || ed.days
  const changed = day.value && (s(cur?.day) !== day.value || s(cur?.crew) !== crew.value || len !== ed.nowDays)
  preview.value = changed ? { job: ed.job, day: String(day.value), crew: String(crew.value), days: len } : null
})
const [passcode] = defineField('passcode')
const passLocked = ref(true) // read-only until focused, so no autofill
// An old version remembered the passcode on the device; forget it.
onMounted(() => { try { localStorage.removeItem('sf-passcode') } catch {} })

function openEdit(job: unknown) {
  const id = s(job)
  const r = data.value?.ranked.find((x) => s(x.job) === id)
  const current = data.value?.plan.find((p) => s(p.job) === id)
  const techs = Number(r?.techs ?? current?.techs ?? 2)
  const days0 = Number(r?.days ?? current?.days ?? 1) // the Backlog estimate
  editing.value = { job: id, title: `${id} · ${org(r?.organisation || current?.organisation, id)}`, techs, days: days0, nowDays: Number(current?.days) || days0, current }
  // Fresh form each time: passcode always starts empty.
  const curDays = Number(current?.days) || days0
  resetForm({ values: { crew: techs > 2 ? 'A+B' : s(current?.crew) || 'A', day: s(current?.day) || workDays.value[0] || '', days: curDays, passcode: '' } })
  passLocked.value = true
  message.value = ''
  log('panel open', { job: id, techs, days: days0, now: current ? `${s(current.day)} crew ${s(current.crew)} (${s(current.source)})` : 'not planned', replanning: replanning.value })
}
function closeEdit() {
  preview.value = null // not saved: the card goes back (a saved move is in justSaved)
  editing.value = null
  resetForm({ values: { day: '', crew: 'A', days: 1, passcode: '' } })
  passLocked.value = true
}

async function save(action: 'lock' | 'move' | 'unlock') {
  if (!editing.value) return
  saving.value = true
  message.value = ''
  try {
    const len = Number(days.value) || editing.value.days
    const body =
      action === 'lock' && editing.value.current
        ? { job: editing.value.job, action, crew: s(editing.value.current.crew), day: s(editing.value.current.day), days: len }
        : { job: editing.value.job, action, crew: crew.value, day: day.value, days: len }
    const runNow = true // every save re-runs the planner; n8n waits if a run is already going, so nothing is lost
    log('save →', { ...body, replan: runNow })
    const res = await $fetch('/api/override', { method: 'POST', body: { ...body, passcode: passcode.value, replan: runNow } })
    log('save ✓', res)
    sessionPasscode = String(passcode.value)
    if (action !== 'unlock') justSaved.value.set(editing.value.job, { day: String(body.day), crew: String(body.crew), days: len })
    if (runNow) startReplanWatch()
    else { queued.value++; log(`queued – will be included in the next update (${queued.value} waiting)`) }
    reloadFresh()
    closeEdit() // done: the card already sits where it was saved
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
        <!-- a full reload: newest build, fresh data, every unsaved preview / open panel / timer gone -->
        <button title="Reload the page from scratch (latest version + fresh data; unsaved changes are discarded)" @click="hardRefresh()">
          {{ pending ? 'Loading…' : 'Refresh' }}
        </button>
        <a v-if="config.public.sheetUrl" :href="config.public.sheetUrl" target="_blank" rel="noopener">Open Google Sheet</a>
      </div>
    </header>

    <p v-if="error" class="banner bad">Couldn't load the plan: {{ error.statusMessage || error.message }}</p>
    <div v-if="pending && !data" class="loading">
      <div class="spinner" />
      <p>Loading the plan from the Google Sheet… this takes a few seconds.</p>
    </div>
    <p v-if="replanning" class="banner replan">
      <span class="spinner small-spin" />
      <span>
        Saved. Updating the plan… the other jobs refresh by themselves in about 20 seconds.
        <b v-if="queued">{{ queued }} newer change(s) saved – they go into one more update right after this one.</b>
        You can keep making changes.
      </span>
    </p>
    <p v-else-if="queued" class="banner">
      {{ queued }} saved change(s) are waiting for an update that didn't start – press Refresh in a moment.
    </p>
    <p v-else-if="justUpdated" class="banner done">✓ Plan updated with your changes.</p>
    <!-- saved changes with no run (e.g. the page was reloaded while a run was queued): one click starts it -->
    <form v-else-if="pendingChanges.length" class="banner pendingrow" @submit.prevent="updateNow">
      <span>{{ pendingChanges.length }} change(s) saved but not in the plan yet: {{ pendingChanges.map((o) => `${s(o.job)} ${s(o.action)}`).join(', ') }}.</span>
      <input v-if="needPass" v-model="passNow" type="text" class="secret" autocomplete="off" placeholder="Passcode" aria-label="Passcode" />
      <button type="submit" class="primary" :disabled="updating">{{ updating ? 'Starting…' : needPass ? 'Update the plan' : 'Update the plan now' }}</button>
      <span v-if="updateError" class="bad small">{{ updateError }}</span>
    </form>

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

    <!-- why a lane refused the card (shown while dragging over it, and a moment after letting go) -->
    <AppToast />

    <!-- Calendar: weeks as rows, Mon–Fri as columns (on a phone, swipe sideways through the days) -->
    <section v-if="tab === 'plan' && data" :key="calKey" class="cal" :class="{ dragging: dragJob }">
      <p class="legend small">
        <span v-for="c in allCrews" :key="c.id" :class="crewClass(c.id)"><i class="chip">Crew {{ c.id }}</i> {{ c.name }}</span>
        <span class="crew-AB"><i class="chip">Both</i> 4-person job</span>
        <span><i class="swatch school" /> VIC school holidays</span>
        <span><i class="swatch off" /> Public holiday</span>
      </p>

      <div v-for="w in weeks" :key="w.label" class="week">
        <h2>{{ w.label }}</h2>
        <div class="weekgrid">
          <!-- wide screens: date headings first, then the long bars, then the day boxes (like FullCalendar) -->
          <div v-for="c in w.days" :key="'h' + c.iso" class="dayhead" :class="{ off: c.holiday, school: c.school }">{{ dayLabel(c.iso) }}</div>
          <!-- multi-day jobs: one bar across their days (one strip row per crew), dragged by the bar -->
          <VueDraggable v-for="sk in stripKeys(w.days[0]!.iso)" :key="sk" v-model="strips[sk]!" v-bind="stripOptions"
            data-strip="1" class="strip" @start="onDragStart" @end="onDragEnd">
            <button v-for="g in strips[sk]" :key="s(g.job) + g.col" type="button" class="job span"
              :class="[crewClass(g.crew), { incoming: g.moving, 'cont-left': !g.first, 'cont-right': !g.last }]"
              :style="{ gridColumn: `${g.col + 1} / span ${g.span}` }" :data-job="s(g.job)" @click="onCardClick(g.job)">
              <span v-if="!g.first" class="contmark">← continued</span>
              <i class="chip">{{ s(g.crew) === 'A+B' ? 'Both' : 'Crew ' + s(g.crew) }}</i>
              <strong>{{ s(g.job) }}</strong> <span>{{ org(g.organisation, g.job) }}</span>
              <span class="small">{{ g.suburb }} · {{ spanLabel(g) }}</span>
              <span v-if="g.moving === 'unsaved'" class="tag unsaved-tag">Not saved yet – confirm in the box</span>
              <span v-else-if="g.moving === 'saved'" class="tag saved-tag">✓ Saved here</span>
              <span v-else-if="s(g.source).startsWith('Dan')" class="tag">🔒 {{ g.source }}</span>
              <span v-if="!g.last" class="contmark">continues →</span>
              <span v-if="g.last" class="resize" role="button" :aria-label="`Resize ${s(g.job)}`" title="Drag to make the job longer or shorter"
                @pointerdown="startResize($event, g, firstDayOf(s(g.job)))" />
            </button>
          </VueDraggable>
          <article v-for="c in w.days" :key="c.iso" class="cell" :data-day="c.iso" :class="{ off: c.holiday, out: !c.work && !c.holiday, school: c.school }">
            <h3>{{ dayLabel(c.iso) }}</h3>
            <span v-if="c.school" class="mtag">VIC school holidays</span>
            <p v-if="c.holiday" class="small muted">Public holiday · no work</p>
            <p v-else-if="!c.work" class="small muted">Not in this plan</p>
            <template v-else>
              <!-- one draggable list per lane: both-crew jobs (only when there are some), then Crew A, Crew B -->
              <VueDraggable v-for="ln in [...(lanes[laneKey(c.iso, 'A+B')]?.length ? [{ id: 'A+B' }] : []), ...crews]" :key="ln.id"
                v-model="lanes[laneKey(c.iso, ln.id)]!" v-bind="dragOptions" :data-lane="laneKey(c.iso, ln.id)"
                class="lane" :class="[crewClass(ln.id), { both: ln.id === 'A+B', nodrop: dragJob && blocked?.lane === laneKey(c.iso, ln.id),
                  ready: dragJob && laneFits(c.iso, ln.id), cant: dragJob && !laneFits(c.iso, ln.id), over: dragJob && hoverLane === laneKey(c.iso, ln.id) }]"
                @start="onDragStart" @end="onDragEnd" @add="onDrop($event, c.iso, ln.id)">
                <template v-for="p in lanes[laneKey(c.iso, ln.id)]" :key="s(p.job) + p.part">
                <!-- day 2+ of a multi-day job: a slim bar joined to the first-day card -->
                <button v-if="isContinued(p)" type="button" class="job cont" :class="[crewClass(p.crew), { incoming: p.moving }]"
                  :data-job="s(p.job)" @click="onCardClick(p.job)">
                  ↳ <strong>{{ s(p.job) }}</strong> continued from {{ startDayOf(p) }} <span class="muted">({{ p.part }})</span>
                </button>
                <button v-else type="button" class="job"
                  :class="[crewClass(p.crew), { incoming: p.moving, multi: spanLabel(p) }]" :data-job="s(p.job)" @click="onCardClick(p.job)">
                  <i class="chip">{{ s(p.crew) === 'A+B' ? 'Both' : 'Crew ' + s(p.crew) }}</i>
                  <strong>{{ s(p.job) }}</strong> {{ org(p.organisation, p.job) }}
                  <span class="small">{{ p.suburb }} · {{ spanLabel(p) || s(p.days) + 'd' }}</span>
                  <span v-if="p.moving === 'unsaved'" class="tag unsaved-tag">Not saved yet – confirm in the box</span>
                  <span v-else-if="p.moving === 'saved'" class="tag saved-tag">✓ Saved here</span>
                  <template v-else>
                    <span class="small muted reason">{{ p.reason }}</span>
                    <span v-if="s(p.source).startsWith('Dan')" class="tag">🔒 {{ p.source }}</span>
                  </template>
                  <span class="resize" role="button" :aria-label="`Resize ${s(p.job)}`" title="Drag to make the job longer or shorter"
                    @pointerdown="startResize($event, p, c.iso)" />
                </button>
                </template>
                <p v-if="ln.id !== 'A+B'" class="small free" :class="{ full: laneRoom(c.iso, ln.id) === 'full' }">
                  {{ dragJob && laneFits(c.iso, ln.id) ? `Drop here → Crew ${ln.id}` : `Crew ${ln.id}` }} · {{ laneRoom(c.iso, ln.id) }}
                </p>
              </VueDraggable>
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
        <p v-if="editing.dropped && errors.day" class="banner bad small">
          {{ Number(days) !== editing.nowDays && s(editing.current?.day) === day ? `Can't make it ${days} day${Number(days) === 1 ? '' : 's'}` : "Can't move it there" }}: {{ errors.day }}
        </p>
        <p v-else-if="editing.dropped" class="banner small">
          <template v-if="Number(days) !== editing.nowDays">Set to <b>{{ days }} day{{ Number(days) === 1 ? '' : 's' }}</b> (was {{ editing.nowDays }}{{ editing.nowDays !== editing.days ? `, estimate ${editing.days}` : '' }}), </template>
          <template v-if="Number(days) !== editing.nowDays && s(editing.current?.day) === day && s(editing.current?.crew) === crew">staying on <b>{{ dayLabel(day) }}</b>, <b>Crew {{ crew }}</b>?</template>
          <template v-else>move to <b>{{ dayLabel(day) }}</b>, <b>{{ crew === 'A+B' ? 'both crews' : 'Crew ' + crew }}</b>?</template>
          Press <b>Save</b> to confirm.
        </p>

        <button v-if="editing.current && !editing.dropped" type="button" :disabled="saving" @click="saveWithPasscode('lock')">🔒 Lock where it is</button>

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
        <label>Length
          <select v-model="days" :class="{ invalid: errors.days }">
            <option v-for="d in lengthOptions" :key="d" :value="d">{{ d }} day{{ d === 1 ? '' : 's' }}</option>
          </select>
          <span v-if="errors.days" class="small bad">{{ errors.days }}</span>
          <span v-else-if="Number(days) !== editing.days" class="small muted">The Backlog estimate is {{ editing.days }} day(s); your length replaces it for this job.</span>
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
          <button type="submit" class="primary" :disabled="saving">{{ saving ? 'Saving…' : 'Save move' }}</button>
          <button v-if="lockedNow(editing.job)" type="button" :disabled="saving" @click="saveWithPasscode('unlock')">Unlock</button>
          <button type="button" @click="closeEdit">Close</button>
        </div>
        <p v-if="message" class="small" :class="/Saved|Unlocked/.test(message) ? 'ok' : 'bad'">{{ message }}</p>
        <p class="small muted">Changes go to the Overrides tab, and the plan updates straight away (about 20 seconds).</p>
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
.banner.pendingrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.banner.pendingrow input { width: 120px; padding: 6px 8px; }
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
.cal { display: grid; gap: 12px; }
.week h2 { margin-bottom: 4px; font-size: 15px; }
.weekgrid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; align-items: start; } /* each day only as tall as its jobs */
.cell { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 5px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
/* denser cards inside the days */
.cell .job { padding: 5px 7px; font-size: 13px; line-height: 1.35; margin: 0; }
.cell .job strong { font-size: 14px; }
.cell .job .reason { -webkit-line-clamp: 1; }
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
.lane { flex: 0 0 auto; display: flex; flex-direction: column; gap: 3px; min-height: 0; padding: 2px; border-radius: 8px; }
.lane:empty { min-height: 16px; } /* day taken by a long bar: a slim strip, still a drop target */
.lane + .lane { border-top: 1px dashed var(--line); padding-top: 5px; margin-top: 2px; } /* Crew A above, Crew B below */
.lane.both { flex: 0 0 auto; min-height: 0; }
/* while a card is dragged: lanes that can take it get a thin dashed outline in THEIR crew colour (blue = it would
   go to Crew A, green = Crew B); the lane under the pointer fills; lanes that can't take it fade */
.lane.ready { outline: 1.5px dashed color-mix(in srgb, var(--c) 55%, transparent); outline-offset: 2px; min-height: 44px;
  flex: 1 1 auto; } /* a lane that can take the card fills the free space of its day: a drop "a bit low" still lands in it */
.cal.dragging .cell { min-height: 120px; }
.lane.cant { min-height: 10px; }
.lane.ready .free { border-color: var(--c); color: var(--c); }
.lane.ready.over { outline: 2px dashed var(--c); background: color-mix(in srgb, var(--c) 9%, #fff); }
.lane.ready.over .free { font-weight: 600; }
.lane.cant { opacity: 0.45; }
.lane.nodrop { outline: 2px dashed var(--bad); outline-offset: 2px; background: #fdecea; opacity: 1; }
.lane .job { cursor: grab; touch-action: none; }
/* resize handle on the right edge of every card and bar (FullCalendar style); two thin lines show on hover */
.job { position: relative; }
.resize { position: absolute; top: 0; right: 0; width: 14px; height: 100%; cursor: ew-resize; touch-action: none; border-radius: 0 8px 8px 0; }
.resize::after { content: ''; position: absolute; top: 50%; right: 4px; width: 3px; height: 14px; margin-top: -7px; border-left: 2px solid var(--c); border-right: 2px solid var(--c); opacity: 0; }
.job:hover .resize::after { opacity: 0.6; }
@media (max-width: 900px) { .resize { display: none; } }
/* wide screens: one heading row for the week (the day boxes' own headings are hidden) */
.dayhead { font-size: 13px; font-weight: 700; padding: 6px 8px; border-radius: 8px; background: var(--card); border: 1px solid var(--line); }
.dayhead.off { background: repeating-linear-gradient(45deg, #f1f2f4, #f1f2f4 6px, #e7e9ec 6px, #e7e9ec 12px); }
.dayhead.school { background: #fff3cc; border-color: #f0d58a; }
@media (min-width: 901px) { .cell > h3 { display: none; } }
@media (max-width: 900px) { .dayhead { display: none; } }
/* multi-day on wide screens: a strip row per crew under the headings; each bar spans its columns (subgrid) */
.strip { grid-column: 1 / span 5; display: grid; grid-template-columns: subgrid; align-items: start; min-height: 0; margin-bottom: -4px; }
/* one slim line per bar: chip, job, name, dates – anything that doesn't fit is cut with … */
.job.span { margin: 0; display: block; padding: 4px 10px; font-size: 13px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border-left: 4px solid var(--c); background: color-mix(in srgb, var(--c) 10%, #fff); }
.job.span > * { display: inline; margin-right: 6px; }
.job.span .small { display: inline; color: var(--muted); }
.job.span.cont-left { border-left-style: dashed; border-top-left-radius: 0; border-bottom-left-radius: 0; }
.job.span.cont-right { border-right: 4px dashed var(--c); border-top-right-radius: 0; border-bottom-right-radius: 0; }
.contmark { font-size: 12px; font-weight: 600; color: var(--c); }
/* multi-day on narrow screens: the first-day card gets a thick right edge "→", the other days a slim joined bar */
.job.multi { border-right: 6px solid var(--c); }
.lane .job.cont { cursor: pointer; touch-action: auto; padding: 4px 8px; font-size: 13px; border-left: 6px solid var(--c);
  background: color-mix(in srgb, var(--c) 14%, #fff); color: var(--ink); }
.lane .job:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12); }
.job.incoming { border: 2px dashed var(--c); border-left-width: 4px; background: color-mix(in srgb, var(--c) 10%, #fff); animation: pop 0.25s ease-out; }
/* SortableJS: where the card will land (placeholder), the card picked up, and the copy following the pointer */
.drag-placeholder { opacity: 0.45; outline: 2px dashed var(--c); outline-offset: -2px; }
.drag-chosen { box-shadow: 0 0 0 2px var(--c); }
.drag-flying { opacity: 1 !important; transform: rotate(2deg); box-shadow: 0 14px 30px rgba(0, 0, 0, 0.28); background: #fff; cursor: grabbing; }
.unsaved-tag { background: #fff3cc; color: #5c4300; }
.saved-tag { background: #e9f6ec; color: var(--ok); }
@keyframes pop { from { transform: scale(0.94); opacity: 0.3; } to { transform: none; opacity: 1; } }
.free { margin: 0; color: var(--muted); border: 1px dashed var(--line); border-radius: 6px; padding: 3px 8px; font-size: 12px; }
.free.full { border-style: solid; background: #f1f2f4; color: #8a919c; }
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
