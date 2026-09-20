import type { IBuffer, Terminal } from '@xterm/headless'

type OscLinkMarker = { dispose(): void; line?: number }
type OscLinkEntry = { id: number; lines: OscLinkMarker[] }
type TerminalBuffers = Pick<Terminal, 'buffer'>

/** xterm's line markers outlive overwritten hyperlinks, including redraws without scrollback. */
export function createTerminalOscLinkRetirement(terminal: TerminalBuffers): () => number {
  const SWEEP_GROWTH = 1024
  let nextSweepSize = SWEEP_GROWTH
  let previousSize = 0

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function isLinkEntry(value: unknown): value is OscLinkEntry {
    return (
      isRecord(value) &&
      typeof value.id === 'number' &&
      Array.isArray(value.lines) &&
      value.lines.every((line: unknown) => isRecord(line) && typeof line.dispose === 'function')
    )
  }

  function addAttributeLink(attributes: unknown, links: Set<number>): void {
    if (
      isRecord(attributes) &&
      isRecord(attributes.extended) &&
      typeof attributes.extended.urlId === 'number' &&
      attributes.extended.urlId !== 0
    ) {
      links.add(attributes.extended.urlId)
    }
  }

  function collectBufferLinks(buffer: IBuffer, links: Set<number>): void {
    const cell = buffer.getNullCell()
    // Scan every cell: marker rows are incomplete after autowrap and reflow.
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row)
      if (!line) {
        continue
      }
      for (let column = 0; column < line.length; column++) {
        addAttributeLink(line.getCell(column, cell), links)
      }
    }
  }

  return (): number => {
    if (!('_core' in terminal) || !isRecord(terminal._core)) {
      return 0
    }
    const core = terminal._core
    const service = core._oscLinkService
    const input = core._inputHandler
    if (
      !isRecord(service) ||
      !(service._dataByLinkId instanceof Map) ||
      !isRecord(input) ||
      typeof input.getAttrData !== 'function'
    ) {
      return 0
    }
    const entries: Map<unknown, unknown> = service._dataByLinkId
    if (entries.size < previousSize) {
      nextSweepSize = Math.min(nextSweepSize, entries.size + SWEEP_GROWTH)
    }
    previousSize = entries.size
    if (entries.size < nextSweepSize) {
      return 0
    }

    const live = new Set<number>()
    collectBufferLinks(terminal.buffer.normal, live)
    collectBufferLinks(terminal.buffer.alternate, live)
    // An OSC 8 open can finish one write before its linked text arrives in the next.
    addAttributeLink(input.getAttrData(), live)
    const bufferService = core._bufferService
    if (isRecord(bufferService) && isRecord(bufferService.buffers)) {
      for (const buffer of [bufferService.buffers.normal, bufferService.buffers.alt]) {
        if (isRecord(buffer)) {
          addAttributeLink(buffer.savedCurAttrData, live)
        }
      }
    }

    const before = entries.size
    for (const entry of entries.values()) {
      if (isLinkEntry(entry) && !live.has(entry.id)) {
        // Dispose only link-owned markers; xterm removes both registry indexes itself.
        const markers = entry.lines.slice()
        for (const marker of markers) {
          marker.dispose()
        }
      }
    }
    previousSize = entries.size
    nextSweepSize = entries.size + SWEEP_GROWTH
    return before - entries.size
  }
}

export class TerminalOscLinkRetirementAddon {
  declare private subscription: { dispose(): void } | undefined

  activate(terminal: Pick<Terminal, 'buffer' | 'onWriteParsed'>): void {
    this.subscription = terminal.onWriteParsed(createTerminalOscLinkRetirement(terminal))
  }

  dispose(): void {
    this.subscription?.dispose()
    this.subscription = undefined
  }
}
