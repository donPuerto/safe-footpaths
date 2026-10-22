<script setup lang="ts">
// Renders the toasts fired through useToast(). Put <AppToast /> once in the page.
const { toasts, dismiss } = useToast()
const icon = { error: '⛔', success: '✓', info: 'ℹ' } as const
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <p v-for="t in toasts" :key="t.id" class="toast-item" :class="t.kind" role="status">
        <span class="toast-text">{{ icon[t.kind] }} {{ t.text }}</span>
        <button type="button" class="toast-close" aria-label="Close" @click="dismiss(t.id)">✕</button>
      </p>
    </TransitionGroup>
  </div>
</template>

<style>
.toasts { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 30; display: grid; gap: 8px; width: min(560px, calc(100vw - 32px)); pointer-events: none; }
.toast-item { margin: 0; display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px 10px 14px; border-radius: 10px; font-size: 14px; color: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25); pointer-events: auto; }
.toast-item.error { background: var(--bad); }
.toast-item.success { background: var(--ok); }
.toast-item.info { background: var(--accent); }
.toast-text { flex: 1 1 auto; }
.toast-close { flex: 0 0 auto; background: transparent; border: 1px solid rgba(255, 255, 255, 0.6); color: #fff; border-radius: 6px; padding: 0 7px; line-height: 1.5; cursor: pointer; font: inherit; }
.toast-close:hover { background: rgba(255, 255, 255, 0.15); }
.toast-enter-active, .toast-leave-active { transition: opacity 0.2s, transform 0.2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
