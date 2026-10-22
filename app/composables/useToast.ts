// Fire-and-forget messages shown by <AppToast /> (one instance in app.vue).
//   const toast = useToast()
//   toast.error('Could not save.')                     // red, auto-hides after 8 s
//   toast.success('Saved', { timeout: 4000 })           // green
//   toast.info('Updating…', { id: 'replan', timeout: 0 }) // sticky until dismiss('replan'); same id = replace, not stack
export type ToastKind = 'error' | 'success' | 'info'
export interface Toast { id: string; kind: ToastKind; text: string }
interface Options { kind?: ToastKind; timeout?: number; id?: string }

export const useToast = () => {
  const toasts = useState<Toast[]>('sf-toasts', () => [])
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const dismiss = (id: string) => {
    clearTimeout(timers.get(id))
    timers.delete(id)
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }
  const show = (text: string, { kind = 'info', timeout = 8000, id }: Options = {}) => {
    const tid = id || `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    clearTimeout(timers.get(tid))
    const t: Toast = { id: tid, kind, text }
    const i = toasts.value.findIndex((x) => x.id === tid)
    toasts.value = i >= 0 ? toasts.value.map((x, k) => (k === i ? t : x)) : [...toasts.value, t]
    if (timeout > 0) timers.set(tid, setTimeout(() => dismiss(tid), timeout))
    return tid
  }
  return {
    toasts,
    show,
    dismiss,
    error: (text: string, o: Omit<Options, 'kind'> = {}) => show(text, { ...o, kind: 'error' }),
    success: (text: string, o: Omit<Options, 'kind'> = {}) => show(text, { ...o, kind: 'success' }),
    info: (text: string, o: Omit<Options, 'kind'> = {}) => show(text, { ...o, kind: 'info' }),
  }
}
