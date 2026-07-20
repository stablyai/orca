import { describe, expect, it } from 'vitest'
import { buildSplitCandidates, resolveSplitSourceHost } from './panel-split-candidates'
import type { PinnedTerminalPanel, PinnedWebPanel } from '../../../shared/types'

const web = (id: string, title: string, url: string): PinnedWebPanel => ({ id, title, url })
const term = (id: string, title: string, command: string, host?: string): PinnedTerminalPanel => ({
  id,
  title,
  command,
  ...(host ? { host } : {})
})

describe('buildSplitCandidates', () => {
  it('for a web source lists other web panels and blank browser, not self', () => {
    const items = buildSplitCandidates({
      source: { kind: 'web', panelId: 'a' },
      webPanels: [
        web('a', 'Langfuse', 'https://a.example/'),
        web('b', 'Prom', 'https://prom.example/')
      ],
      terminalPanels: [],
      includeDuplicate: true
    })
    expect(items.map((i) => i.id)).toEqual(['web:b', 'blank-browser', 'duplicate'])
    expect(items[0].choice).toEqual({ type: 'panel', kind: 'web', panelId: 'b' })
    expect(items[1].choice).toEqual({ type: 'blank-browser' })
  })

  it('for a terminal source filters to same host only', () => {
    const items = buildSplitCandidates({
      source: { kind: 'terminal', panelId: 'nvtop-b', host: 'node-b' },
      terminalPanels: [
        term('nvtop-b', 'nvtop B', 'nvtop', 'node-b'),
        term('btop-b', 'btop B', 'btop', 'node-b'),
        term('nvtop-c', 'nvtop C', 'nvtop', 'node-c'),
        term('local', 'local btop', 'btop')
      ],
      webPanels: [web('w', 'Dash', 'https://x.example/')],
      includeDuplicate: false
    })
    expect(items.map((i) => i.id)).toEqual(['terminal:btop-b', 'blank-shell'])
    expect(items[1].choice).toEqual({
      type: 'blank-shell',
      host: 'node-b',
      label: 'node-b'
    })
  })

  it('shell source uses shell host for same-host filter', () => {
    const host = resolveSplitSourceHost({ id: 'x', kind: 'shell', host: 'node-d' }, [
      term('t', 't', 'htop', 'node-d')
    ])
    expect(host).toBe('node-d')
  })
})
