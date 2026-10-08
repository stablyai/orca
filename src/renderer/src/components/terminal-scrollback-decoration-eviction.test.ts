// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Entry = { line: number; id: number }
type SortedList = {
  insert(value: Entry): void
  delete(value: Entry): boolean
  clear(): void
  values(): IterableIterator<Entry>
  getKeyIterator(key: number): IterableIterator<Entry>
  _getKey(value: Entry): number
}
type Decoration = { marker: { line: number } }
type Service = {
  _decorations: SortedList
  decorations: Iterable<Decoration>
  onDecorationRemoved(callback: () => void): { dispose(): void }
}

const terminals: Terminal[] = []
function setup(scrollback = 1000): { terminal: Terminal; service: Service } {
  const terminal = new Terminal({ allowProposedApi: true, scrollback, rows: 24 })
  terminals.push(terminal)
  const container = document.createElement('div')
  document.body.append(container)
  terminal.open(container)
  const service = (terminal as unknown as { _core: { _decorationService: Service } })._core
    ._decorationService
  return { terminal, service }
}

function list(): SortedList {
  const { service } = setup()
  const Constructor = service._decorations.constructor as new (
    key: (entry: Entry) => number,
    log: { warn(): void }
  ) => SortedList
  return new Constructor((entry) => entry?.line, { warn() {} })
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10 })
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('scrollback decoration eviction (#10879)', () => {
  it.each([250, 500, 1000])('removes %i disposed keys with linear lookup work', (count) => {
    const sorted = list()
    const entries = Array.from({ length: count }, (_, id) => ({ line: id, id }))
    entries.forEach((entry) => sorted.insert(entry))
    expect([...sorted.values()]).toEqual(entries)
    const keyReads = vi.spyOn(sorted, '_getKey')
    try {
      for (const entry of entries) {
        entry.line = -1
        expect(sorted.delete(entry)).toBe(true)
      }
      expect([...sorted.values()]).toEqual([])
      console.info(`evict ${count}: ${keyReads.mock.calls.length} key reads`)
      expect(keyReads.mock.calls.length).toBeLessThanOrEqual(count * 4)
    } finally {
      sorted.clear()
    }
  })

  it('keeps duplicate identities, live-key queries, reinsertion and snapshots correct', () => {
    const sorted = list()
    const a = { line: 10, id: 1 }
    const b = { line: 20, id: 2 }
    try {
      sorted.insert(b)
      sorted.insert(a)
      sorted.insert(a)
      const snapshot = sorted.values()
      a.line -= 5
      b.line -= 5
      expect([...sorted.getKeyIterator(5)]).toEqual([a, a])
      expect(sorted.delete(a)).toBe(true)
      expect(sorted.delete(a)).toBe(true)
      expect(sorted.delete(a)).toBe(false)
      expect([...sorted.values()]).toEqual([b])
      expect([...snapshot]).toEqual([a, a, b])
      sorted.insert(a)
      expect([...sorted.values()]).toEqual([a, b])
      sorted.clear()
      expect(sorted.delete(a)).toBe(false)
      sorted.insert(b)
      expect(sorted.delete(b)).toBe(true)
      expect([...sorted.values()]).toEqual([])
    } finally {
      sorted.clear()
    }
  })

  it('preserves duplicate counts through partial compaction and reinsertion', () => {
    const sorted = list()
    const entry = { line: 0, id: 0 }
    try {
      sorted.insert(entry)
      sorted.insert(entry)
      sorted.insert(entry)
      expect(sorted.delete(entry)).toBe(true)
      expect([...sorted.values()]).toEqual([entry, entry])
      expect(sorted.delete(entry)).toBe(true)
      expect([...sorted.values()]).toEqual([entry])
      sorted.insert(entry)
      expect(sorted.delete(entry)).toBe(true)
      expect(sorted.delete(entry)).toBe(true)
      expect(sorted.delete(entry)).toBe(false)
      expect([...sorted.values()]).toEqual([])
    } finally {
      sorted.clear()
    }
  })

  it('matches identity membership through mixed key mutation and compaction', () => {
    const sorted = list()
    let seed = 10879
    const random = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32
    const entries = Array.from({ length: 100 }, (_, id) => ({ line: id, id }))
    const live = new Set<Entry>()
    try {
      for (let step = 0; step < 2000; step++) {
        const entry = entries[Math.floor(random() * entries.length)]
        if (random() < 0.45 && !live.has(entry)) {
          entry.line = entry.id
          sorted.insert(entry)
          live.add(entry)
        } else {
          entry.line = -1
          expect(sorted.delete(entry)).toBe(live.delete(entry))
        }
        if (step % 17 === 0) {
          expect([...sorted.values()]).toEqual([...live].sort((a, b) => a.line - b.line))
        }
      }
    } finally {
      sorted.clear()
    }
  })

  it('evicts real search highlights without changing marker events or retained output', async () => {
    const { terminal, service } = setup()
    const search = new SearchAddon()
    terminal.loadAddon(search)
    await write(terminal, 'needle\r\n'.repeat(1000))
    expect(
      search.findNext('needle', {
        decorations: {
          matchBackground: '#ffcc00',
          matchOverviewRuler: '#ffcc00',
          activeMatchColorOverviewRuler: '#ff9900'
        }
      })
    ).toBe(true)
    const decorations = [...service.decorations]
    expect(decorations.length).toBeGreaterThanOrEqual(1000)
    const removed = vi.fn()
    service.onDecorationRemoved(removed)
    const marker = terminal.registerMarker(0)
    expect(marker).toBeDefined()
    const disposed = vi.fn(() => {
      expect(marker?.isDisposed).toBe(true)
      expect(marker?.line).toBe(-1)
    })
    marker?.onDispose(disposed)
    const keyReads = vi.spyOn(service._decorations, '_getKey')
    await write(terminal, 'plain\r\n'.repeat(2000))
    expect(removed).toHaveBeenCalledTimes(decorations.length)
    expect([...service.decorations]).toEqual([])
    expect(disposed).toHaveBeenCalledOnce()
    expect(terminal.buffer.active.length).toBe(1024)
    expect(terminal.buffer.active.getLine(1000)?.translateToString(true)).toBe('plain')
    expect(keyReads.mock.calls.length).toBeLessThanOrEqual(decorations.length * 4)
    search.clearDecorations()
    expect(
      search.findNext('plain', {
        decorations: {
          matchBackground: '#ffcc00',
          matchOverviewRuler: '#ffcc00',
          activeMatchColorOverviewRuler: '#ff9900'
        }
      })
    ).toBe(true)
    expect([...service.decorations].length).toBeGreaterThan(0)
    search.clearDecorations()
    expect([...service.decorations]).toEqual([])
  })
})
