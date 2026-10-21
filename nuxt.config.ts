// Safe Footpaths – one page that reads the plan from the Google Sheet (through n8n)
// and lets Dan move or lock a job. Secrets stay server-side in runtimeConfig.
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  ssr: false, // a small internal tool: client-rendered, data comes from /api
  app: {
    head: {
      title: 'Safe Footpaths – 2-week plan',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
  runtimeConfig: {
    n8nWebhookBase: process.env.N8N_WEBHOOK_BASE || '',
    n8nWebhookKey: process.env.N8N_WEBHOOK_KEY || '',
    appPasscode: process.env.APP_PASSCODE || '',
    public: {
      sheetUrl: process.env.NUXT_PUBLIC_SHEET_URL || '',
    },
  },
})
