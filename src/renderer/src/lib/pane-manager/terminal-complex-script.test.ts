import { describe, expect, it } from 'vitest'
import { terminalOutputRequiresDomRenderer } from './terminal-complex-script'

describe('terminalOutputRequiresDomRenderer', () => {
  it('detects Arabic terminal output', () => {
    expect(terminalOutputRequiresDomRenderer('Arabic: السلام عليكم')).toBe(true)
  })

  it('detects RTL scripts that need browser text shaping/order', () => {
    expect(terminalOutputRequiresDomRenderer('Hebrew: שלום')).toBe(true)
  })

  it('does not disable WebGL for ordinary terminal output', () => {
    expect(terminalOutputRequiresDomRenderer('abc 123 ── ✓')).toBe(false)
  })
})
