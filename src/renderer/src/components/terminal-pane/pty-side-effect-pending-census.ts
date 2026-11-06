import { registerRendererMemoryProfileContributor } from '@/lib/renderer-memory-profile'

/** Queue counts for one PTY output processor, read at heap-highwater time. */
export type PtySideEffectGauge = {
  /** Entries still awaiting apply; saturates at MAX_PENDING_PTY_SIDE_EFFECTS. */
  pending: () => number
  /** Effects still referenced by the queue array, excluding cleared consumed slots. */
  retained: () => number
}

// Weak gauges cannot pin leaked processor closures; only the owning processor retains its gauge strongly.
const gaugeRefs = new Set<WeakRef<PtySideEffectGauge>>()

// Why: bounds this module even if registrations outrun both disposal and collection.
const MAX_TRACKED_GAUGES = 512

function pruneCollectedGauges(): void {
  for (const ref of gaugeRefs) {
    if (ref.deref() === undefined) {
      gaugeRefs.delete(ref)
    }
  }
}

export function registerPtySideEffectPendingGauge(gauge: PtySideEffectGauge): () => void {
  if (gaugeRefs.size >= MAX_TRACKED_GAUGES) {
    pruneCollectedGauges()
  }
  if (gaugeRefs.size >= MAX_TRACKED_GAUGES) {
    return () => undefined
  }
  gaugeRefs.add(new WeakRef(gauge))
  // Capture gauge in the processor’s release closure so this registry remains a weak owner.
  return () => {
    for (const ref of gaugeRefs) {
      if (ref.deref() === gauge) {
        gaugeRefs.delete(ref)
        return
      }
    }
  }
}

// Individual queues are capped; rising processor count means leaked owners, while capped queues imply throttled drains.
registerRendererMemoryProfileContributor('ptySideEffects', () => {
  let pending = 0
  let retained = 0
  let processors = 0
  for (const ref of gaugeRefs) {
    const gauge = ref.deref()
    if (!gauge) {
      gaugeRefs.delete(ref)
      continue
    }
    pending += gauge.pending()
    retained += gauge.retained()
    processors += 1
  }
  return { pending, retained, processors }
})
