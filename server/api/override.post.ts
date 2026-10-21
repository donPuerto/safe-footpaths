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
  const { n8nWebhookBase, n8nWebhookKey, appPasscode } = useRuntimeConfig()
  const body = await readBody<OverrideRequest>(event)

  if (!appPasscode || !same(String(body?.passcode ?? ''), appPasscode))
    throw createError({ statusCode: 401, statusMessage: 'Wrong passcode' })

  const job = String(body.job ?? '').trim()
  const action = body.action
  if (!/^\d+$/.test(job)) throw createError({ statusCode: 400, statusMessage: 'Bad job number' })
  if (!['lock', 'move', 'unlock'].includes(action)) throw createError({ statusCode: 400, statusMessage: 'Bad action' })
  if (action !== 'unlock') {
    if (!['A', 'B', 'A+B'].includes(String(body.crew))) throw createError({ statusCode: 400, statusMessage: 'Bad crew' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.day))) throw createError({ statusCode: 400, statusMessage: 'Bad day' })
  }

  const row = {
    job,
    action,
    crew: action === 'unlock' ? '' : body.crew,
    day: action === 'unlock' ? '' : body.day,
    updated_by: 'Dan (web page)',
    updated_at: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  }
  try {
    await $fetch(`${n8nWebhookBase}/sf-override`, { method: 'POST', body: row, headers: { 'x-sf-key': n8nWebhookKey } })
  } catch (e: any) {
    throw createError({ statusCode: 502, statusMessage: `Could not save to the Sheet (${e?.statusCode || 'no response'})` })
  }
  return { ok: true, saved: row }
})
