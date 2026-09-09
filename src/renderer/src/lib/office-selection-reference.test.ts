import { describe, expect, it } from 'vitest'
import { formatOfficeSelectionReference } from './office-selection-handoff'

describe('office selection reference', () => {
  it('names the document and every selected element path', () => {
    const reference = formatOfficeSelectionReference('/w/deck.pptx', [
      { path: '/slide[1]/shape[@id=100000]', type: 'textbox', text: 'Revenue' },
      { path: '/slide[1]/picture[@id=100001]', type: 'picture', text: null }
    ])
    expect(reference).toContain('/w/deck.pptx')
    // The paths are what the agent acts on; they survive edits, which is the whole point.
    expect(reference).toContain('/slide[1]/shape[@id=100000]')
    expect(reference).toContain('/slide[1]/picture[@id=100001]')
    // The label is what the reader checks the agent against.
    expect(reference).toContain('"Revenue"')
  })

  it('collapses whitespace and truncates a long label', () => {
    const reference = formatOfficeSelectionReference('/w/a.docx', [
      { path: '/body/p[1]', type: 'paragraph', text: `  many\n\n words   ${'x'.repeat(200)}` }
    ])
    expect(reference).not.toContain('\n\n')
    expect(reference).toContain('many words')
    expect(reference.length).toBeLessThan(200)
  })

  it('caps the list rather than pasting a hundred lines into a composer', () => {
    const nodes = Array.from({ length: 25 }, (_, index) => ({
      path: `/slide[1]/shape[${index}]`,
      type: 'shape',
      text: null
    }))
    const reference = formatOfficeSelectionReference('/w/deck.pptx', nodes)
    expect(reference).toContain('…and 5 more')
    expect(reference.split('\n')).toHaveLength(22)
  })
})
