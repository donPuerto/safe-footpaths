// Order of jobs within a crew's day ("seq": 1 = the crew's first job).
//  - seqOf(job): Dan's saved order (Overrides row), overridden by an order just set on the page (localSeq)
//    until the fresh data carries it; Infinity when Dan set none (the planner's order applies).
//  - beginDrag(laneKey) + onReorder(event, day, crew): a drag inside a lane -> the day's new order -> confirm panel.
//  - submitReorder (VeeValidate: passcode required) saves one Overrides row per job: a pinned job keeps its
//    move/lock row + seq; an unpinned job gets an "order" row (seq only, no pin). cancelReorder reverts.
import { useForm } from 'vee-validate'
import type { OverrideRow } from '../../shared/types'
import type { DraggableEvent } from 'vue-draggable-plus'

export interface DayOrderDeps {
  overrides: Ref<Map<string, OverrideRow>>
  laneJobs: (laneKey: string) => string[] // current job order of a lane (display order)
  redraw: () => void // re-render the calendar from data
  afterSave: () => void // e.g. reload fresh + watch for the planner run
  getPasscode: () => string
  setPasscode: (code: string) => void
  log: (...a: unknown[]) => void
}

export const useDayOrder = (deps: DayOrderDeps) => {
  const localSeq = ref(new Map<string, number>())
  const seqOf = (job: string) => {
    const l = localSeq.value.get(job)
    if (l !== undefined) return l
    const o = Number(deps.overrides.value.get(job)?.seq)
    return o >= 1 ? o : Infinity
  }
  // drop local orders once the fresh data carries them
  const syncFromData = () => {
    for (const [job, v] of localSeq.value) if (Number(deps.overrides.value.get(job)?.seq) === v) localSeq.value.delete(job)
  }

  const reorder = ref<{ day: string; crew: string; jobs: string[] } | null>(null)
  const reorderSaving = ref(false)
  const reorderError = ref('')
  const form = useForm({
    validationSchema: { passcode: (v: string) => (v?.trim() ? true : 'Type the passcode to save.') },
    initialValues: { passcode: '' },
  })
  const [reorderPass] = form.defineField('passcode')
  const orderErrors = form.errors

  let dragStartOrder: string[] = []
  const beginDrag = (laneKey: string) => { dragStartOrder = deps.laneJobs(laneKey) }

  // the drag library restores the DOM before its update event, so apply the drag's indices to the start order
  const onReorder = (e: DraggableEvent, day: string, crew: string) => {
    const from = e.oldDraggableIndex ?? e.oldIndex ?? 0
    const to = e.newDraggableIndex ?? e.newIndex ?? 0
    const arr = [...new Set(dragStartOrder)]
    if (from === to || from >= arr.length || arr.length < 2) return
    const [moved] = arr.splice(from, 1)
    arr.splice(Math.min(to, arr.length), 0, moved!)
    arr.forEach((j, i) => localSeq.value.set(j, i + 1)) // keep the new order on screen while the panel is open
    reorder.value = { day, crew, jobs: arr }
    form.resetForm({ values: { passcode: '' } })
    reorderError.value = ''
    deps.log('reorder', { day, crew, order: arr })
  }

  const cancelReorder = () => {
    for (const j of reorder.value?.jobs ?? []) localSeq.value.delete(j)
    reorder.value = null
    form.resetForm({ values: { passcode: '' } })
    deps.redraw()
  }

  const saveReorder = async () => {
    const r = reorder.value
    if (!r) return
    const code = String(reorderPass.value).trim()
    reorderSaving.value = true
    reorderError.value = ''
    try {
      for (const [i, job] of r.jobs.entries()) {
        const o = deps.overrides.value.get(job)
        const pinned = o && !['unlock', 'order'].includes(String(o.action))
        const body = pinned
          ? { job, action: String(o!.action), crew: String(o!.crew), day: String(o!.day), days: Number(o!.days) || undefined, seq: i + 1 }
          : { job, action: 'order', seq: i + 1 }
        deps.log('save order →', body)
        await $fetch('/api/override', { method: 'POST', body: { ...body, passcode: code } })
      }
      deps.setPasscode(code)
      reorder.value = null
      form.resetForm({ values: { passcode: '' } })
      deps.afterSave()
    } catch (e: any) {
      if (e?.statusCode === 401) form.setFieldError('passcode', 'Wrong passcode.')
      else reorderError.value = e?.statusMessage || e?.data?.statusMessage || 'Could not save the order.'
      deps.log('save order ✗', e?.statusCode)
    } finally {
      reorderSaving.value = false
    }
  }
  const submitReorder = form.handleSubmit(() => saveReorder(), ({ errors }) => deps.log('order save blocked by form checks', errors))

  return { localSeq, seqOf, syncFromData, reorder, reorderPass, orderErrors, reorderSaving, reorderError, beginDrag, onReorder, cancelReorder, submitReorder }
}
