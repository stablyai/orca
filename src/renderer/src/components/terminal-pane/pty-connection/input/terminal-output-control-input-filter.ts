const ESC = '\x1b'

function csiFinalIndex(data: string): number | null {
  for (let index = 2; index < data.length; index += 1) {
    const code = data.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) {
      return index
    }
  }
  return null
}

function isTerminalOutputModeControl(csi: string): boolean {
  const final = csi.at(-1)
  const params = csi.slice(2, -1)
  return (
    ((final === 'h' || final === 'l') && /^\?[0-9;:]*$/.test(params)) ||
    (final === 'm' && /^>4;[0-9]+$/.test(params))
  )
}

/** Drops renderer-output mode controls if xterm ever surfaces them through its non-user input channel. */
export class TerminalOutputControlInputFilter {
  private pending = ''

  filter(data: string): string {
    let remaining = this.pending + data
    this.pending = ''
    let forwarded = ''
    while (remaining) {
      const escapeIndex = remaining.indexOf(ESC)
      if (escapeIndex === -1) {
        return `${forwarded}${remaining}`
      }
      forwarded += remaining.slice(0, escapeIndex)
      remaining = remaining.slice(escapeIndex)
      if (remaining.length === 1) {
        this.pending = remaining
        return forwarded
      }
      if (remaining[1] !== '[') {
        forwarded += remaining.slice(0, 2)
        remaining = remaining.slice(2)
        continue
      }
      const finalIndex = csiFinalIndex(remaining)
      if (finalIndex === null) {
        this.pending = remaining
        return forwarded
      }
      const csi = remaining.slice(0, finalIndex + 1)
      if (!isTerminalOutputModeControl(csi)) {
        forwarded += csi
      }
      remaining = remaining.slice(finalIndex + 1)
    }
    return forwarded
  }

  reset(): void {
    this.pending = ''
  }
}
