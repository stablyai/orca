import { describe, expect, it } from 'vitest'
import { canCommandCodeOutputOwnPane } from './command-code-output-ownership'

describe('canCommandCodeOutputOwnPane', () => {
  it('allows the banner fallback when no stronger identity exists', () => {
    expect(canCommandCodeOutputOwnPane({})).toBe(true)
    expect(canCommandCodeOutputOwnPane({ paneOwnerAgent: 'unknown' })).toBe(true)
  })

  it('allows Command Code ownership evidence', () => {
    expect(canCommandCodeOutputOwnPane({ paneOwnerAgent: 'command-code' })).toBe(true)
    expect(canCommandCodeOutputOwnPane({ foregroundAgent: 'command-code' })).toBe(true)
  })

  it('rejects another agent owner or foreground process', () => {
    expect(canCommandCodeOutputOwnPane({ paneOwnerAgent: 'claude' })).toBe(false)
    expect(canCommandCodeOutputOwnPane({ foregroundAgent: 'claude' })).toBe(false)
    expect(
      canCommandCodeOutputOwnPane({
        paneOwnerAgent: 'unknown',
        retainedPaneOwnerAgent: 'claude'
      })
    ).toBe(false)
  })

  it('prefers the current foreground process over stale pane ownership', () => {
    expect(
      canCommandCodeOutputOwnPane({
        foregroundAgent: 'command-code',
        paneOwnerAgent: 'claude',
        retainedPaneOwnerAgent: 'claude'
      })
    ).toBe(true)
    expect(
      canCommandCodeOutputOwnPane({
        foregroundAgent: 'claude',
        paneOwnerAgent: 'command-code'
      })
    ).toBe(false)
  })

  it('rejects output observed at a confirmed shell prompt', () => {
    expect(canCommandCodeOutputOwnPane({ shellForeground: true })).toBe(false)
  })
})
