import { timingSafeEqual } from 'node:crypto'
import type { OverrideRequest } from '../../shared/types'

const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// POST /api/override – Dan moves, locks or unlocks a job.
// Saved to the Overrides tab (one row per job, latest wins); the next workflow run keeps it.
export default defineEventHandler(async (event) => {
  const { n8nWebhookBase, n8nWebhookKey } = useRuntimeConfig()
  // Read at request time (not baked in at build), so a new passcode in Vercel needs no code change.
  const appPasscode = String(process.env.APP_PASSCODE ?? useRuntimeConfig().appPasscode ?? '').trim()
  const body = await readBody<OverrideRequest>(event)

  if (!appPasscode || !same(String(body?.passcode ?? '').trim(), appPasscode))
    throw createError({ statusCode: 401, statusMessage: 'Wrong passcode' })

  // "replan": nothing to save, just run the planner (the page sends it when a queued change is waiting)
  if (body.action === 'replan') {
    try {
      await $fetch(`${n8nWebhookBase}/sf-override`, { method: 'POST', body: { action: 'replan' }, headers: { 'x-sf-key': n8nWebhookKey } })
    } catch (e: any) {
      throw createError({ statusCode: 502, statusMessage: `Could not start the planner (${e?.statusCode || 'no response'})` })
    }
    return { ok: true, replanning: true }
  }

  const job = String(body.job ?? '').trim()
  const action = body.action
  if (!/^\d+$/.test(job)) throw createError({ statusCode: 400, statusMessage: 'Bad job number' })
  if (!['lock', 'move', 'unlock', 'order'].includes(action)) throw createError({ statusCode: 400, statusMessage: 'Bad action' })
  // order within the day (1 = first); "order" alone doesn't pin the job to a day
  const seq = body.seq === undefined || body.seq === null ? '' : Number(body.seq)
  if (seq !== '' && !(Number.isInteger(seq) && seq >= 1 && seq <= 99)) throw createError({ statusCode: 400, statusMessage: 'Bad seq' })
  if (action === 'order' && seq === '') throw createError({ statusCode: 400, statusMessage: 'order needs seq' })
  const noPlace = action === 'unlock' || action === 'order'
  if (!noPlace) {
    if (!['A', 'B', 'A+B'].includes(String(body.crew))) throw createError({ statusCode: 400, statusMessage: 'Bad crew' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.day))) throw createError({ statusCode: 400, statusMessage: 'Bad day' })
  }

  // optional resize: Dan's length in days replaces the Backlog estimate for this job
  const days = body.days === undefined || body.days === null ? '' : Number(body.days)
  if (days !== '' && !(days > 0 && days <= 10)) throw createError({ statusCode: 400, statusMessage: 'Bad days' })

  const row = {
    job,
    action,
    crew: noPlace ? '' : body.crew,
    day: noPlace ? '' : body.day,
    days: noPlace ? '' : days,
    seq: action === 'unlock' ? '' : seq,
    updated_by: 'Dan (web page)',
    updated_at: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', // to the second, like run_at
  }
  try {
    // replan:false = save only; the page starts one planner run for all queued changes later
    await $fetch(`${n8nWebhookBase}/sf-override`, {
      method: 'POST',
      body: { ...row, replan: body.replan !== false },
      headers: { 'x-sf-key': n8nWebhookKey },
    })
  } catch (e: any) {
    throw createError({ statusCode: 502, statusMessage: `Could not save to the Sheet (${e?.statusCode || 'no response'})` })
  }
  return { ok: true, saved: row }
})
