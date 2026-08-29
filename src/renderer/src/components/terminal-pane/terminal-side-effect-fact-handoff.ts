import type { PtyIncarnationId } from '../../../../shared/pty-incarnation'
import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'

const HANDOFF_FACT_BUFFER_TTL_MS = 15_000
const MAX_HANDOFF_FACT_BATCHES = 64
const MAX_HANDOFF_FACT_PTYS = 32

export type TerminalSideEffectFactAuthority = {
  incarnationId: PtyIncarnationId | null
  paneKey: string | null
  tabId: string | null
  worktreeId: string | null
}

type HandoffFactBuffer = {
  batches: TerminalSideEffectBatch[]
  authority: TerminalSideEffectFactAuthority
  expiresAtMs: number
  expiryTimer: ReturnType<typeof setTimeout>
}

const handoffFactBuffersByPtyId = new Map<string, HandoffFactBuffer>()

function deleteHandoffFactBuffer(ptyId: string): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (buffer) {
    clearTimeout(buffer.expiryTimer)
    handoffFactBuffersByPtyId.delete(ptyId)
  }
}

export function openTerminalSideEffectFactHandoff(
  ptyId: string,
  authority: TerminalSideEffectFactAuthority
): void {
  const nowMs = Date.now()
  for (const [bufferedPtyId, buffer] of handoffFactBuffersByPtyId) {
    if (buffer.expiresAtMs <= nowMs) {
      deleteHandoffFactBuffer(bufferedPtyId)
    }
  }
  deleteHandoffFactBuffer(ptyId)
  if (handoffFactBuffersByPtyId.size >= MAX_HANDOFF_FACT_PTYS) {
    const oldestPtyId = handoffFactBuffersByPtyId.keys().next().value
    if (typeof oldestPtyId === 'string') {
      deleteHandoffFactBuffer(oldestPtyId)
    }
  }
  const buffer: HandoffFactBuffer = {
    batches: [],
    authority: { ...authority },
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

export function bufferTerminalSideEffectFactHandoff(batch: TerminalSideEffectBatch): void {
  const buffer = handoffFactBuffersByPtyId.get(batch.ptyId)
  if (!buffer) {
    return
  }
  if (buffer.expiresAtMs <= Date.now()) {
    deleteHandoffFactBuffer(batch.ptyId)
    return
  }
  if (batch.replay) {
    return
  }
  if (buffer.batches.length >= MAX_HANDOFF_FACT_BATCHES) {
    buffer.batches.shift()
  }
  buffer.batches.push(batch)
}

export function drainTerminalSideEffectFactHandoff(
  ptyId: string,
  applyBatch: (batch: TerminalSideEffectBatch) => void
): void {
  const buffer = handoffFactBuffersByPtyId.get(ptyId)
  if (!buffer) {
    return
  }
  deleteHandoffFactBuffer(ptyId)
  if (buffer.expiresAtMs <= Date.now()) {
    return
  }
  for (const batch of buffer.batches) {
    applyBatch(batch)
  }
}

export function getTerminalSideEffectFactHandoffAuthority(
  ptyId: string
): TerminalSideEffectFactAuthority | undefined {
  return handoffFactBuffersByPtyId.get(ptyId)?.authority
}

export function resetTerminalSideEffectFactHandoffs(): void {
  for (const ptyId of Array.from(handoffFactBuffersByPtyId.keys())) {
    deleteHandoffFactBuffer(ptyId)
  }
}
