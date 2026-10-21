import type { PlanData } from '../../shared/types'

// GET /api/plan – everything the page shows, read from the Sheet by n8n (~5 s).
// The webhook key never reaches the browser.
// Without ?fresh the response may be served from Vercel's edge cache for 30 s (then refreshed in
// the background), so the page opens instantly; Refresh and saves pass ?fresh to skip the cache.
export default defineEventHandler(async (event) => {
  const { n8nWebhookBase, n8nWebhookKey } = useRuntimeConfig()
  if (!n8nWebhookBase || !n8nWebhookKey)
    throw createError({ statusCode: 500, statusMessage: 'Server not configured: set N8N_WEBHOOK_BASE and N8N_WEBHOOK_KEY' })

  const fresh = getQuery(event).fresh !== undefined
  setHeader(event, 'Cache-Control', fresh ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=600')

  try {
    return await $fetch<PlanData>(`${n8nWebhookBase}/sf-plan`, { headers: { 'x-sf-key': n8nWebhookKey } })
  } catch (e: any) {
    setHeader(event, 'Cache-Control', 'no-store')
    throw createError({ statusCode: 502, statusMessage: `Could not read the plan from n8n (${e?.statusCode || 'no response'})` })
  }
})
