import { registerRendererMemoryProfileContributor } from '@/lib/renderer-memory-profile'

/** Queue counts for one PTY output processor, read at heap-highwater time. */
export type PtySideEffectGauge = {
  /** Entries still awaiting apply; saturates at MAX_PENDING_PTY_SIDE_EFFECTS. */
  pending: () => number
  /** Entries the queue array still holds — drained-but-uncompacted ones included, so this is the count that tracks retained bytes. */
  retained: () => number
}

// Why weak: a diagnostic for leaks must not be able to cause one. The owning processor holds
// the only strong reference, so a teardown path that forgets to dispose strands an empty
// WeakRef here instead of pinning the processor's whole closure (callbacks, tracker, terminal).
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
  // Why delete by identity: this closure is handed to the processor, so closing over `gauge`
  // is what makes the processor — never this module — the gauge's strong owner.
  return () => {
    for (const ref of gaugeRefs) {
      if (ref.deref() === gauge) {
        gaugeRefs.delete(ref)
        return
      }
    }
  }
}

// Why processor count is the signal: each queue is capped at MAX_PENDING_PTY_SIDE_EFFECTS and
// evicts oldest-first, so one processor can never grow without bound. Aggregate growth means
// processors outliving their panes; queues parked at the cap mean a drain starved by throttling.
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
