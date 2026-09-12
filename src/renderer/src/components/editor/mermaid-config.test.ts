import { describe, expect, it } from 'vitest'

import { getMermaidConfig } from './mermaid-config'

describe('getMermaidConfig', () => {
  it('uses strict Mermaid rendering with HTML labels by default', () => {
    expect(getMermaidConfig(false)).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'default',
      htmlLabels: true
    })
  })

  it('can disable HTML labels when a caller needs SVG-native text only', () => {
    expect(getMermaidConfig(false, false)).toMatchObject({
      startOnLoad: false,
      theme: 'default',
      htmlLabels: false
    })
  })

  it('switches to the dark mermaid theme when the preview is dark', () => {
    expect(getMermaidConfig(true)).toMatchObject({
      theme: 'dark',
      htmlLabels: true
    })
  })
})
