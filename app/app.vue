<script setup lang="ts">
import type { PlanData, PlanRow, OverrideRow } from '../shared/types'

const config = useRuntimeConfig()
const { data, pending, error, refresh } = useFetch<PlanData>('/api/plan', { server: false })

const tab = ref<'plan' | 'ranked' | 'human'>('plan')
const s = (v: unknown) => String(v ?? '').trim()

// ---- settings -> work days in the window (weekdays, minus public holidays) ----
const settings = computed(() => Object.fromEntries((data.value?.settings ?? []).map((r) => [s(r.key), s(r.value)])))
const crews = computed(() => [
  { id: 'A', name: settings.value.crew_A || 'Crew A' },
  { id: 'B', name: settings.value.crew_B || 'Crew B' },
])
const workDays = computed(() => {
  const start = settings.value.window_start
  const end = settings.value.window_end
  if (!start || !end) return [...new Set((data.value?.plan ?? []).map((p) => s(p.day)))].sort()
  const off = new Set((settings.value.public_holidays || '').split(';').map((x) => x.trim()))
  const out: string[] = []
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10)
    if (d.getUTCDay() % 6 !== 0 && !off.has(iso)) out.push(iso)
  }
  return out
})
const dayLabel = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

const cell = (day: string, crew: string) => (data.value?.plan ?? []).filter((p) => s(p.day) === day && s(p.crew).split('+').includes(crew))
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

// ---- Move / Lock panel ----
const editing = ref<{ job: string; title: string; techs: number; current?: PlanRow } | null>(null)
const form = reactive({ crew: 'A', day: '' })
const passcode = ref(import.meta.client ? localStorage.getItem('sf-passcode') || '' : '')
const saving = ref(false)
const message = ref('')

function openEdit(job: unknown) {
  const id = s(job)
  const r = data.value?.ranked.find((x) => s(x.job) === id)
  const current = data.value?.plan.find((p) => s(p.job) === id)
  const techs = Number(r?.techs ?? current?.techs ?? 2)
  editing.value = { job: id, title: `${id} · ${r?.organisation || current?.organisation || ''}`, techs, current }
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
    await refresh()
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
        <button @click="refresh()" :disabled="pending">{{ pending ? 'Loading…' : 'Refresh' }}</button>
        <a v-if="config.public.sheetUrl" :href="config.public.sheetUrl" target="_blank" rel="noopener">Open Google Sheet</a>
      </div>
    </header>

    <p v-if="error" class="banner bad">Couldn't load the plan: {{ error.statusMessage || error.message }}</p>
    <p v-if="pendingChanges.length" class="banner">
      {{ pendingChanges.length }} change(s) by Dan saved since the last run — run the workflow to apply:
      {{ pendingChanges.map((o) => `${s(o.job)} ${s(o.action)}`).join(', ') }}
    </p>

    <nav>
      <button :class="{ on: tab === 'plan' }" @click="tab = 'plan'">Crews by day</button>
      <button :class="{ on: tab === 'ranked' }" @click="tab = 'ranked'">Ranked ({{ data?.ranked.length ?? 0 }})</button>
      <button :class="{ on: tab === 'human' }" @click="tab = 'human'">Needs a human ({{ data?.needsHuman.length ?? 0 }})</button>
    </nav>

    <!-- Crews by day -->
    <section v-if="tab === 'plan'" class="days">
      <article v-for="d in workDays" :key="d" class="day">
        <h2>{{ dayLabel(d) }}</h2>
        <div class="crews">
          <div v-for="c in crews" :key="c.id" class="crew">
            <h3>Crew {{ c.id }} <span class="muted">{{ c.name }}</span></h3>
            <p v-if="!cell(d, c.id).length" class="muted small">Free</p>
            <button v-for="p in cell(d, c.id)" :key="s(p.job) + p.part" class="job" @click="openEdit(p.job)">
              <strong>{{ s(p.job) }}</strong> {{ p.organisation }}
              <span class="small">{{ p.suburb }} · {{ s(p.days) }}d {{ p.part }}</span>
              <span class="small muted">{{ p.reason }}</span>
              <span v-if="s(p.source).startsWith('Dan')" class="tag">🔒 {{ p.source }}</span>
            </button>
          </div>
        </div>
      </article>
    </section>

    <!-- Ranked backlog -->
    <section v-if="tab === 'ranked'" class="list">
      <div v-for="r in data?.ranked ?? []" :key="s(r.job)" class="row">
        <div class="rank">{{ s(r.rank) }}</div>
        <div class="grow">
          <strong>{{ s(r.job) }}</strong> {{ r.organisation }}
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

        <button v-if="editing.current" type="button" :disabled="saving || !passcode" @click="save('lock')">🔒 Lock where it is</button>

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
nav { display: flex; gap: 6px; margin: 16px 0; overflow-x: auto; }
nav button.on { background: var(--ink); color: #fff; border-color: var(--ink); }
.days { display: grid; gap: 12px; }
.day { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.crews { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.crew { min-width: 0; }
.job { display: block; width: 100%; text-align: left; margin-bottom: 6px; background: #f9fbff; }
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
  .crews { grid-template-columns: 1fr; }
  .row { flex-wrap: wrap; }
}
@media (min-width: 641px) { .sheet { align-items: center; } .panel { border-radius: 14px; } }
</style>
