import { describe, expect, it } from 'vitest'
import { MAX_PINNED_TERMINAL_PANELS, normalizePinnedTerminalPanels } from './pinned-terminal-panels'

describe('pinned terminal panel normalization', () => {
  it('returns empty for non-array input', () => {
    expect(normalizePinnedTerminalPanels(undefined)).toEqual([])
    expect(normalizePinnedTerminalPanels(null)).toEqual([])
    expect(normalizePinnedTerminalPanels('nvtop')).toEqual([])
  })

  it('keeps well-formed panels and trims fields', () => {
    const panels = normalizePinnedTerminalPanels([
      { id: 'a', title: ' GPU ', command: ' nvtop ' },
      { id: 'b', title: 'Remote GPU', command: 'ssh node-b nvtop' }
    ])
    expect(panels).toEqual([
      { id: 'a', title: 'GPU', command: 'nvtop' },
      { id: 'b', title: 'Remote GPU', command: 'ssh node-b nvtop' }
    ])
  })

  it('rejects commands containing control characters', () => {
    const panels = normalizePinnedTerminalPanels([
      { id: 'a', title: 'x', command: 'nvtop\u0000' },
      { id: 'b', title: 'x', command: 'nv\u001btop' },
      { id: 'c', title: 'x', command: 'nvtop\u007f' },
      { id: 'ok', title: 'x', command: 'nvtop' }
    ])
    expect(panels.map((p) => p.id)).toEqual(['ok'])
  })

  it('rejects empty and oversized commands', () => {
    const panels = normalizePinnedTerminalPanels([
      { id: 'a', title: 'x', command: '   ' },
      { id: 'b', title: 'x', command: 'x'.repeat(501) },
      { id: 'ok', title: 'x', command: 'x'.repeat(500) }
    ])
    expect(panels.map((p) => p.id)).toEqual(['ok'])
  })

  it('drops malformed entries without failing the rest', () => {
    const panels = normalizePinnedTerminalPanels([
      null,
      42,
      { title: 'no id', command: 'nvtop' },
      { id: '', title: 'empty id', command: 'nvtop' },
      { id: 'ok', command: 'nvtop' }
    ])
    expect(panels.map((p) => p.id)).toEqual(['ok'])
  })

  it('dedupes ids, keeping the first occurrence', () => {
    const panels = normalizePinnedTerminalPanels([
      { id: 'a', title: 'first', command: 'nvtop' },
      { id: 'a', title: 'second', command: 'btop' }
    ])
    expect(panels).toHaveLength(1)
    expect(panels[0]?.command).toBe('nvtop')
  })

  it('caps the list at MAX_PINNED_TERMINAL_PANELS', () => {
    const entries = Array.from({ length: MAX_PINNED_TERMINAL_PANELS + 3 }, (_, i) => ({
      id: `p${i}`,
      title: `Panel ${i}`,
      command: 'nvtop'
    }))
    expect(normalizePinnedTerminalPanels(entries)).toHaveLength(MAX_PINNED_TERMINAL_PANELS)
  })

  it('falls back to the command when the title is empty and truncates long titles', () => {
    const panels = normalizePinnedTerminalPanels([
      { id: 'a', title: '   ', command: 'watch -n1 nvidia-smi' },
      { id: 'b', title: 'x'.repeat(200), command: 'btop' }
    ])
    expect(panels[0]?.title).toBe('watch -n1 nvidia-smi')
    expect(panels[1]?.title).toHaveLength(60)
  })
})
