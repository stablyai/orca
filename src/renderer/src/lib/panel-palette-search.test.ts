import { describe, expect, it } from 'vitest'
import { searchPanelPaletteResults } from './panel-palette-search'

describe('searchPanelPaletteResults', () => {
  const web = [{ id: 'w1', title: 'Langfuse', url: 'https://langfuse.example/' }]
  const terminal = [
    {
      id: 't1',
      title: 'nvtop B',
      command: 'nvtop',
      host: 'node-b',
      group: 'node-b'
    },
    { id: 't2', title: 'local btop', command: 'btop', enabled: false as const }
  ]
  const layouts = [
    { id: 'l1', title: 'Mesh cockpit', root: { kind: 'web' as const, panelId: 'w1' } }
  ]

  it('returns empty for empty query', () => {
    expect(
      searchPanelPaletteResults({
        query: '',
        webPanels: web,
        terminalPanels: terminal,
        layouts
      })
    ).toEqual([])
  })

  it('matches web panel by host and title', () => {
    const hits = searchPanelPaletteResults({
      query: 'langfuse',
      webPanels: web,
      terminalPanels: terminal,
      layouts
    })
    expect(hits.map((h) => h.id)).toEqual(['pinned-web-panel:w1'])
    expect(hits[0].subtitle).toContain('User Panels')
  })

  it('matches terminal by host and skips disabled', () => {
    const hits = searchPanelPaletteResults({
      query: 'node-b',
      webPanels: web,
      terminalPanels: terminal,
      layouts
    })
    expect(hits.map((h) => h.targetId)).toEqual(['t1'])
  })

  it('matches layouts by title', () => {
    const hits = searchPanelPaletteResults({
      query: 'cockpit',
      webPanels: web,
      terminalPanels: terminal,
      layouts
    })
    expect(hits.map((h) => h.kind)).toEqual(['layout'])
  })
})
