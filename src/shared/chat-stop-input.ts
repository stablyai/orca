import type { WriteSettlement } from './pty-write-settlement'

export type ChatStopInput = { id: string; index: 1 | 2 }
export type ChatStopBinding = {
  ptyId: string
  processIncarnation: string
  generation: number
  isCurrent: () => boolean
}
export type WriteSettlementSink = (settlement: WriteSettlement) => void

export function parseChatStopInput(value: unknown): ChatStopInput | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length < 1 ||
    value.id.length > 64 ||
    !('index' in value) ||
    (value.index !== 1 && value.index !== 2)
  ) {
    return undefined
  }
  return { id: value.id, index: value.index }
}

export function reportWriteSettlement(
  sink: WriteSettlementSink | undefined,
  result: WriteSettlement
): void {
  try {
    sink?.(result)
  } catch {
    /* Observation cannot change input delivery. */
  }
}
