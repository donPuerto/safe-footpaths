import type { PlanData } from '../../shared/types'

// GET /api/plan – everything the page shows, read from the Sheet by n8n.
// The webhook key never reaches the browser.
export default defineEventHandler(async () => {
  const { n8nWebhookBase, n8nWebhookKey } = useRuntimeConfig()
  if (!n8nWebhookBase || !n8nWebhookKey)
    throw createError({ statusCode: 500, statusMessage: 'Server not configured: set N8N_WEBHOOK_BASE and N8N_WEBHOOK_KEY' })

  try {
    return await $fetch<PlanData>(`${n8nWebhookBase}/sf-plan`, { headers: { 'x-sf-key': n8nWebhookKey } })
  } catch (e: any) {
    throw createError({ statusCode: 502, statusMessage: `Could not read the plan from n8n (${e?.statusCode || 'no response'})` })
  }
})
