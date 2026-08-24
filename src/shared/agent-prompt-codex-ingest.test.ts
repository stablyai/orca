import { describe, expect, it } from 'vitest'
import {
  codexAgentPromptCharCount,
  collectCodexPasteMarkers,
  countCodexPasteMarker,
  findCodexPasteMarkerDelta
} from './agent-prompt-codex-ingest'

describe('Codex agent-prompt paste ingest', () => {
  it.each([
    ['astral Unicode', '😀', 1],
    ['CRLF and bare CR', 'a\r\nb\rc', 5],
    ['ESC literalization', 'a\x1bb', 7],
    ['C0 and C1 controls', 'a\x00b\x85c', 3],
    ['LF and tab retention', 'a\nb\tc', 5]
  ])('matches Codex normalization for %s', (_name, prompt, expected) => {
    expect(codexAgentPromptCharCount(prompt)).toBe(expected)
  })

  it('finds one delivery-owned member without predicting its suffix', () => {
    const baseline = collectCodexPasteMarkers(['[Pasted Content 5000 chars]'], 5_000)
    const current = collectCodexPasteMarkers(
      ['[Pasted Content 5000 chars] [Pasted Content 5000 chars] #7'],
      5_000
    )

    expect(findCodexPasteMarkerDelta(baseline, current)).toEqual({
      marker: '[Pasted Content 5000 chars] #7',
      visibleCount: 1
    })
  })

  it('finds a marker split across rendered grid rows', () => {
    const current = collectCodexPasteMarkers(['[Pasted Content ', '5000 chars] #23'], 5_000)

    expect(findCodexPasteMarkerDelta(new Map(), current)).toEqual({
      marker: '[Pasted Content 5000 chars] #23',
      visibleCount: 1
    })
  })

  it('finds an unsuffixed marker added beside a pre-existing identical marker', () => {
    const baseline = collectCodexPasteMarkers(['[Pasted Content 5000 chars]'], 5_000)
    const current = collectCodexPasteMarkers(
      ['[Pasted Content 5000 chars] [Pasted Content 5000 chars]'],
      5_000
    )

    expect(findCodexPasteMarkerDelta(baseline, current)).toEqual({
      marker: '[Pasted Content 5000 chars]',
      visibleCount: 2
    })
  })

  it('rejects redraws, removed baselines, and multiple additions', () => {
    const baseline = collectCodexPasteMarkers(['[Pasted Content 5000 chars]'], 5_000)
    expect(findCodexPasteMarkerDelta(baseline, baseline)).toBeNull()
    expect(findCodexPasteMarkerDelta(baseline, new Map())).toBeNull()
    expect(
      findCodexPasteMarkerDelta(
        baseline,
        collectCodexPasteMarkers(
          ['[Pasted Content 5000 chars] #2 [Pasted Content 5000 chars] #3'],
          5_000
        )
      )
    ).toBeNull()
  })

  it('counts an exact owned marker', () => {
    expect(
      countCodexPasteMarker(
        ['[Pasted Content 5000 chars] #2', '[Pasted Content 5000 chars]'],
        '[Pasted Content 5000 chars] #2'
      )
    ).toBe(1)
  })

  it('counts an exact marker across rendered grid rows', () => {
    expect(
      countCodexPasteMarker(
        ['[Pasted Content 5000', ' chars] #2'],
        '[Pasted Content 5000 chars] #2'
      )
    ).toBe(1)
  })
})
