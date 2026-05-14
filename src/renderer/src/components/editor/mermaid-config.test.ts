import { describe, expect, it } from 'vitest'

import { getMermaidConfig } from './mermaid-config'

describe('getMermaidConfig', () => {
  it('uses strict Mermaid rendering defaults', () => {
    expect(getMermaidConfig(false)).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'default',
      htmlLabels: false
    })
  })

  it('can enable HTML labels for callers that explicitly need them', () => {
    expect(getMermaidConfig(false, true)).toMatchObject({
      startOnLoad: false,
      theme: 'default',
      htmlLabels: true
    })
  })

  it('switches to the dark mermaid theme when the preview is dark', () => {
    expect(getMermaidConfig(true)).toMatchObject({
      theme: 'dark',
      htmlLabels: false
    })
  })
})
