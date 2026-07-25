import { describe, expect, it } from 'vitest'
import { MAX_PINNED_WEB_PANELS, normalizePinnedWebPanels } from './pinned-web-panels'

describe('pinned web panel normalization', () => {
  it('returns empty for non-array input', () => {
    expect(normalizePinnedWebPanels(undefined)).toEqual([])
    expect(normalizePinnedWebPanels(null)).toEqual([])
    expect(normalizePinnedWebPanels('https://a.example')).toEqual([])
    expect(normalizePinnedWebPanels({ 0: { id: 'a', url: 'https://a.example' } })).toEqual([])
  })

  it('keeps well-formed http(s) panels and canonicalizes the URL', () => {
    const panels = normalizePinnedWebPanels([
      { id: 'a', title: ' Grafana ', url: ' https://grafana.example/d/mesh ' },
      { id: 'b', title: 'CI', url: 'http://ci.example' }
    ])
    expect(panels).toEqual([
      { id: 'a', title: 'Grafana', url: 'https://grafana.example/d/mesh' },
      { id: 'b', title: 'CI', url: 'http://ci.example/' }
    ])
  })

  it('rejects non-web schemes that would escape the browser-guest model', () => {
    const panels = normalizePinnedWebPanels([
      { id: 'a', title: 'x', url: 'file:///etc/passwd' },
      { id: 'b', title: 'x', url: 'javascript:alert(1)' },
      { id: 'c', title: 'x', url: 'chrome://settings' },
      { id: 'd', title: 'x', url: 'not a url' },
      { id: 'ok', title: 'x', url: 'https://ok.example' }
    ])
    expect(panels.map((p) => p.id)).toEqual(['ok'])
  })

  it('drops malformed entries without failing the rest', () => {
    const panels = normalizePinnedWebPanels([
      null,
      42,
      { title: 'no id', url: 'https://a.example' },
      { id: '', title: 'empty id', url: 'https://a.example' },
      { id: 'ok', url: 'https://a.example' }
    ])
    expect(panels.map((p) => p.id)).toEqual(['ok'])
  })

  it('dedupes ids, keeping the first occurrence', () => {
    const panels = normalizePinnedWebPanels([
      { id: 'a', title: 'first', url: 'https://one.example' },
      { id: 'a', title: 'second', url: 'https://two.example' }
    ])
    expect(panels).toHaveLength(1)
    expect(panels[0]?.url).toBe('https://one.example/')
  })

  it('caps the list at MAX_PINNED_WEB_PANELS', () => {
    const entries = Array.from({ length: MAX_PINNED_WEB_PANELS + 5 }, (_, i) => ({
      id: `p${i}`,
      title: `Panel ${i}`,
      url: `https://p${i}.example`
    }))
    expect(normalizePinnedWebPanels(entries)).toHaveLength(MAX_PINNED_WEB_PANELS)
  })

  it('falls back to the host when the title is empty and truncates long titles', () => {
    const panels = normalizePinnedWebPanels([
      { id: 'a', title: '   ', url: 'https://grafana.example/d/x' },
      { id: 'b', title: 'x'.repeat(200), url: 'https://b.example' }
    ])
    expect(panels[0]?.title).toBe('grafana.example')
    expect(panels[1]?.title).toHaveLength(60)
  })
})
