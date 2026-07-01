import type { OscTitleUpdate } from './osc-title-extraction'

export type TerminalTabTitleSource = 'authoritative-tab' | 'legacy-window-fallback'

export type AcceptedTerminalTabTitle = {
  title: string
  source: TerminalTabTitleSource
}

export type TerminalTabTitleReducerState = {
  hasObservedAuthoritativeTabTitle: boolean
}

export function createTerminalTabTitleReducerState(): TerminalTabTitleReducerState {
  return { hasObservedAuthoritativeTabTitle: false }
}

export function acceptTerminalTabTitleUpdate(
  state: TerminalTabTitleReducerState,
  update: OscTitleUpdate
): AcceptedTerminalTabTitle | null {
  if (!update.title.trim()) {
    return null
  }

  // Why: OSC 0/1 are the visible-tab authority; OSC 2 is only a fallback
  // until this pane has emitted an authoritative tab title.
  if (update.target === 'both' || update.target === 'icon') {
    state.hasObservedAuthoritativeTabTitle = true
    return {
      title: update.title,
      source: 'authoritative-tab'
    }
  }

  // Why: once OSC 0/1 has named the tab, later OSC 2 window titles must not
  // demote the visible tab label back to legacy shell/window text.
  if (state.hasObservedAuthoritativeTabTitle) {
    return null
  }

  return {
    title: update.title,
    source: 'legacy-window-fallback'
  }
}
