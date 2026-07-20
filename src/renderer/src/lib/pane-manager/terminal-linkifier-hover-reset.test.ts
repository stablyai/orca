import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  isTerminalLinkifierHoverActive,
  resetTerminalLinkifierHoverState
} from './terminal-linkifier-hover-reset'

type FakeLinkifier = { _lastBufferCell?: unknown; _activeLine?: number; _currentLink?: unknown }

function createTerminal(linkifier: FakeLinkifier | null | undefined, hasCore = true): Terminal {
  const core = hasCore ? { linkifier: linkifier ?? undefined } : undefined
  return { _core: core } as unknown as Terminal
}

describe('resetTerminalLinkifierHoverState', () => {
  it('clears the hover cell cache and active line so the next mousemove re-linkifies', () => {
    const linkifier: FakeLinkifier = { _lastBufferCell: { x: 5, y: 5 }, _activeLine: 5 }
    resetTerminalLinkifierHoverState(createTerminal(linkifier))

    expect(linkifier._lastBufferCell).toBeUndefined()
    expect(linkifier._activeLine).toBe(-1)
  })

  it('is a no-op when the linkifier or core internals are unavailable', () => {
    expect(() => resetTerminalLinkifierHoverState(createTerminal(null))).not.toThrow()
    expect(() => resetTerminalLinkifierHoverState(createTerminal(undefined, false))).not.toThrow()
  })

  it('only touches fields that exist so a renamed xterm internal degrades safely', () => {
    const linkifier: FakeLinkifier = {}
    resetTerminalLinkifierHoverState(createTerminal(linkifier))

    expect('_lastBufferCell' in linkifier).toBe(false)
    expect('_activeLine' in linkifier).toBe(false)
  })
})

describe('isTerminalLinkifierHoverActive', () => {
  it('is true only while a link is currently hovered', () => {
    expect(isTerminalLinkifierHoverActive(createTerminal({ _currentLink: { link: 'x' } }))).toBe(
      true
    )
    expect(isTerminalLinkifierHoverActive(createTerminal({ _currentLink: undefined }))).toBe(false)
    expect(isTerminalLinkifierHoverActive(createTerminal({}))).toBe(false)
  })

  it('degrades to false when linkifier internals are unavailable', () => {
    expect(isTerminalLinkifierHoverActive(createTerminal(null))).toBe(false)
    expect(isTerminalLinkifierHoverActive(createTerminal(undefined, false))).toBe(false)
  })
})
