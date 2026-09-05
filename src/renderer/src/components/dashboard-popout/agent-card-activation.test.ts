// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import {
  agentCardActivationHint,
  agentCardClickOpensWorktree,
  isPlatformModifierClick,
  platformModifierClickLabel
} from './agent-card-activation'

const originalUserAgent = navigator.userAgent

function stubUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent })
}

const META = { metaKey: true, ctrlKey: false }
const CTRL = { metaKey: false, ctrlKey: true }
const PLAIN = { metaKey: false, ctrlKey: false }

describe('agent card activation', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    stubUserAgent(originalUserAgent)
  })

  it('reads ⌘ on macOS and ignores Ctrl there', () => {
    stubUserAgent('Macintosh')
    expect(isPlatformModifierClick(META)).toBe(true)
    expect(isPlatformModifierClick(CTRL)).toBe(false)
    expect(platformModifierClickLabel()).toBe('⌘-click')
  })

  it('reads Ctrl elsewhere and ignores the meta key there', () => {
    stubUserAgent('Windows NT 10.0')
    expect(isPlatformModifierClick(CTRL)).toBe(true)
    expect(isPlatformModifierClick(META)).toBe(false)
    expect(platformModifierClickLabel()).toBe('Ctrl+click')
  })

  it('lets the setting choose the plain-click action and the modifier flip it', () => {
    stubUserAgent('Macintosh')
    expect(agentCardClickOpensWorktree(PLAIN, false)).toBe(false)
    expect(agentCardClickOpensWorktree(META, false)).toBe(true)
    expect(agentCardClickOpensWorktree(PLAIN, true)).toBe(true)
    expect(agentCardClickOpensWorktree(META, true)).toBe(false)
  })

  it('names both actions in their current assignment with the platform chord', () => {
    stubUserAgent('Linux x86_64')
    expect(agentCardActivationHint(false)).toBe(
      'Click for a live preview · Ctrl+click to open the worktree'
    )
    expect(agentCardActivationHint(true)).toBe(
      'Click to open the worktree · Ctrl+click for a live preview'
    )
  })
})
