import { describe, expect, it } from 'vitest'
import { buildTerminalInputSourcePath, parseTerminalInputSourcePath } from './terminal-input-source'

describe('terminal input source route', () => {
  it('round-trips a pane key that contains a colon', () => {
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const path = buildTerminalInputSourcePath(paneKey)
    expect(path).toBe('/pane/tab-1%3A11111111-1111-4111-8111-111111111111/last-input')
    expect(parseTerminalInputSourcePath(path)).toBe(paneKey)
  })

  it('accepts an unencoded colon, since a shell hook may not encode it', () => {
    expect(parseTerminalInputSourcePath('/pane/tab-1:leaf/last-input')).toBe('tab-1:leaf')
  })

  it('rejects other paths', () => {
    expect(parseTerminalInputSourcePath('/hook/claude')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane//last-input')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/a/b/last-input')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/a/last-input/')).toBeNull()
    expect(parseTerminalInputSourcePath('/pane/%E0%A4%A/last-input')).toBeNull()
  })
})
