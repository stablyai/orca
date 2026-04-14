import { describe, expect, it } from 'vitest'

import { getMermaidConfig } from './mermaid-config'

describe('getMermaidConfig', () => {
  it('keeps Mermaid HTML labels enabled by default', () => {
    expect(getMermaidConfig(false)).toMatchObject({
      startOnLoad: false,
      theme: 'default',
      htmlLabels: true
    })
  })

  it('can disable HTML labels for sanitized preview paths', () => {
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
