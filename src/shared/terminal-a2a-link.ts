export type A2ALinkType = 'send' | 'message' | 'type' | 'keys'

export type A2ALinkEvent = {
  id: string
  from: string
  to: string
  fromIndex?: number
  toIndex?: number
  fromLabel?: string
  toLabel?: string
  type: A2ALinkType
  text?: string
  timestamp: number
  durationMs?: number
  dispatch?: boolean
  delivered?: boolean
  targetHandle?: string
  bytesWritten?: number
  executionState?: 'delivered' | 'executing' | 'failed' | 'simulated'
  error?: string
}

/**
 * Extracts numeric terminal index from targets like '@2', '#5', '2', or 'terminal-2'.
 */
export function parseTerminalIndex(target: string | undefined | null): number | undefined {
  if (!target) {
    return undefined
  }
  const trimmed = target.trim()
  const match = trimmed.match(/^(?:[@#])?(\d+)$/)
  if (match) {
    const num = Number.parseInt(match[1], 10)
    return Number.isFinite(num) && num > 0 ? num : undefined
  }
  return undefined
}
