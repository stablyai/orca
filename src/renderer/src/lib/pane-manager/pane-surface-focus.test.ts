// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  focusPaneSurface,
  resolvePaneSurfaceFocusTarget,
  resolveVisibleTerminalSurfaceTarget
} from './pane-surface-focus'

afterEach(() => {
  document.body.innerHTML = ''
})

function buildPane(args: { chatOwner?: boolean; composerDisabled?: boolean; hidden?: boolean }): {
  pane: HTMLElement
  helper: HTMLElement
  composer: HTMLElement | null
  root: HTMLElement | null
} {
  const pane = document.createElement('div')
  pane.className = 'pane'
  if (args.hidden) {
    pane.style.display = 'none'
  }
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'xterm-container'
  const helper = document.createElement('textarea')
  helper.className = 'xterm-helper-textarea'
  xtermContainer.append(helper)
  pane.append(xtermContainer)
  let composer: HTMLElement | null = null
  let root: HTMLElement | null = null
  if (args.chatOwner) {
    root = document.createElement('div')
    root.setAttribute('data-native-chat-root', 'true')
    root.setAttribute('data-pane-prevent-terminal-focus', 'true')
    root.tabIndex = -1
    const composerTextarea = document.createElement('textarea')
    composerTextarea.setAttribute('data-native-chat-composer-input', 'true')
    if (args.composerDisabled) {
      composerTextarea.setAttribute('disabled', '')
    }
    root.append(composerTextarea)
    pane.append(root)
    composer = composerTextarea
  }
  document.body.append(pane)
  return { pane, helper, composer, root }
}

describe('focusPaneSurface', () => {
  it('focuses the terminal for a plain terminal pane', () => {
    const { pane } = buildPane({})
    const focusTerminal = vi.fn()

    focusPaneSurface(pane, focusTerminal)

    expect(focusTerminal).toHaveBeenCalled()
  })

  it('focuses the composer input for a chat-owned pane', () => {
    const { pane, composer } = buildPane({ chatOwner: true })
    const focusTerminal = vi.fn()

    focusPaneSurface(pane, focusTerminal)

    expect(document.activeElement).toBe(composer)
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('falls back to the chat root while the composer is disabled', () => {
    const { pane, root } = buildPane({ chatOwner: true, composerDisabled: true })
    const focusTerminal = vi.fn()

    focusPaneSurface(pane, focusTerminal)

    expect(document.activeElement).toBe(root)
    expect(focusTerminal).not.toHaveBeenCalled()
  })
})

describe('resolvePaneSurfaceFocusTarget', () => {
  it('returns null for a plain terminal pane', () => {
    const { pane } = buildPane({})

    expect(resolvePaneSurfaceFocusTarget(pane)).toBeNull()
  })

  it('returns the composer input for a chat-owned pane', () => {
    const { pane, composer } = buildPane({ chatOwner: true })

    expect(resolvePaneSurfaceFocusTarget(pane)).toBe(composer)
  })
})

describe('resolveVisibleTerminalSurfaceTarget', () => {
  it('returns the first visible plain terminal helper', () => {
    const hidden = buildPane({ hidden: true })
    const visible = buildPane({})

    expect(resolveVisibleTerminalSurfaceTarget(document)).toBe(visible.helper)
    expect(resolveVisibleTerminalSurfaceTarget(document)).not.toBe(hidden.helper)
  })

  it('redirects a visible chat-owned pane to its composer', () => {
    const chat = buildPane({ chatOwner: true })

    expect(resolveVisibleTerminalSurfaceTarget(document)).toBe(chat.composer)
  })

  it('skips a hidden chat pane so it cannot mask the visible plain terminal', () => {
    // Why: hidden tabs keep chat portals mounted; the old first-match veto
    // either focused the hidden pane's xterm or gave up entirely.
    buildPane({ chatOwner: true, hidden: true })
    const visible = buildPane({})

    expect(resolveVisibleTerminalSurfaceTarget(document)).toBe(visible.helper)
  })

  it('returns null when no terminal is visible', () => {
    buildPane({ hidden: true })

    expect(resolveVisibleTerminalSurfaceTarget(document)).toBeNull()
  })
})
