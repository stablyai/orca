import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import type { TerminalResidentBinding } from './terminal-resident-binding'
import type { TerminalSemanticResident } from './terminal-semantic-residents'
import type { captureTerminalFactSubject, TerminalFactSubject } from './terminal-fact-subject'

// Bounded handoff buffering bridges watcher removal and async pane registration because replay cannot restore live bells/done. Never-consumed PTYs still drop facts.
const HANDOFF_FACT_BUFFER_TTL_MS = 15_000
const MAX_HANDOFF_FACT_BATCHES = 64
const MAX_HANDOFF_FACT_PTYS = 32

type HandoffFactBuffer = {
  binding: TerminalResidentBinding
  captureSubject: typeof captureTerminalFactSubject
  batches: { batch: TerminalSideEffectBatch; subject: TerminalFactSubject }[]
  expiresAtMs: number
  expiryTimer: ReturnType<typeof setTimeout>
}
const handoffFactBuffersByPtyId = new Map<string, HandoffFactBuffer>()

/** Raw startup retention captures the same original subject without admitting an execution. */
export function captureHandoffFactSubject(ptyId: string): TerminalFactSubject | undefined {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  return buffer ? buffer.captureSubject(buffer.binding.paneKey) : undefined
}

export function deleteHandoffFactBuffer(ptyId: string): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (buffer) {
    clearTimeout(buffer.expiryTimer)
    handoffFactBuffersByPtyId.delete(ptyId)
  }
}

export function openHandoffFactBuffer(
  ptyId: string,
  binding: TerminalResidentBinding,
  captureSubject: typeof captureTerminalFactSubject,
  registration = false
): void {
  if (registration && handoffFactBuffersByPtyId.has(ptyId)) {
    return
  }
  const nowMs = Date.now()
  for (const [bufferedPtyId, buffer] of handoffFactBuffersByPtyId) {
    if (buffer.expiresAtMs <= nowMs) {
      deleteHandoffFactBuffer(bufferedPtyId)
    }
  }
  const retained = handoffFactBuffersByPtyId.get(ptyId)?.batches ?? []
  deleteHandoffFactBuffer(ptyId)
  if (handoffFactBuffersByPtyId.size >= MAX_HANDOFF_FACT_PTYS) {
    const oldestPtyId = handoffFactBuffersByPtyId.keys().next().value
    if (typeof oldestPtyId === 'string') {
      deleteHandoffFactBuffer(oldestPtyId)
    }
  }
  const buffer: HandoffFactBuffer = {
    binding,
    captureSubject,
    batches: retained,
    expiresAtMs: nowMs + HANDOFF_FACT_BUFFER_TTL_MS,
    expiryTimer: setTimeout(() => {
      if (handoffFactBuffersByPtyId.get(ptyId) === buffer) {
        handoffFactBuffersByPtyId.delete(ptyId)
      }
    }, HANDOFF_FACT_BUFFER_TTL_MS)
  }
  buffer.expiryTimer.unref?.()
  handoffFactBuffersByPtyId.set(ptyId, buffer)
}

export function bufferHandoffFactBatch(batch: TerminalSideEffectBatch): void {
  const buffer = handoffFactBuffersByPtyId.get(batch.ptyId)
  if (!buffer) {
    return
  }
  if (buffer.expiresAtMs <= Date.now()) {
    deleteHandoffFactBuffer(batch.ptyId)
    return
  }
  // Why: replay batches are snapshots the next consumer requests for itself.
  if (batch.replay) {
    return
  }
  if (buffer.batches.length >= MAX_HANDOFF_FACT_BATCHES) {
    buffer.batches.shift()
  }
  buffer.batches.push({ batch, subject: buffer.captureSubject(buffer.binding.paneKey) })
}

export function drainHandoffFactBuffer(ptyId: string, resident: TerminalSemanticResident): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (!buffer) {
    return
  }
  deleteHandoffFactBuffer(ptyId)
  if (buffer.expiresAtMs <= Date.now()) {
    return
  }
  for (const { batch, subject } of buffer.batches) {
    resident.policy.observeRetainedFacts(batch, subject)
  }
}

export function resetHandoffFacts(): void {
  for (const ptyId of handoffFactBuffersByPtyId.keys()) {
    deleteHandoffFactBuffer(ptyId)
  }
}
