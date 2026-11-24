export type TerminalScrollBufferType = 'normal' | 'alternate'

export type TerminalScrollBufferTarget = {
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
    }
  }
}

export type TerminalScrollBufferSnapshot = {
  bufferType: TerminalScrollBufferType
  viewportY: number
  baseY: number
}

export function readTerminalScrollBufferSnapshot(
  terminal: TerminalScrollBufferTarget
): TerminalScrollBufferSnapshot | null {
  const buffer = terminal.buffer?.active
  const viewportY = buffer?.viewportY
  const baseY = buffer?.baseY
  if (typeof viewportY !== 'number' || typeof baseY !== 'number') {
    return null
  }
  return {
    bufferType: buffer?.type === 'alternate' ? 'alternate' : 'normal',
    viewportY,
    baseY
  }
}

export function isTerminalViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY
}

export function clampTerminalViewportY(viewportY: number, baseY: number): number {
  return Math.max(0, Math.min(viewportY, baseY))
}

export function safeTerminalScrollCall(scroll: () => void): boolean {
  try {
    scroll()
    return true
  } catch (err) {
    if (err instanceof TypeError && /dimensions/.test(err.message)) {
      return false
    }
    throw err
  }
}
