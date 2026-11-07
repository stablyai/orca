import { describe, expect, it } from 'vitest'
import {
  getPreviousVisibleForTerminalPane,
  isTerminalPaneVisibilityResume
} from './pane-visibility-identity'

describe('terminal pane visibility resume tracking', () => {
  it('ignores previous visibility from a different terminal identity', () => {
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-old', cwd: '/repo', isVisible: false },
        tabId: 'tab-new',
        cwd: '/repo'
      })
    ).toBeNull()
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-1', cwd: '/repo-old', isVisible: false },
        tabId: 'tab-1',
        cwd: '/repo-new'
      })
    ).toBeNull()
    expect(
      getPreviousVisibleForTerminalPane({
        previous: { tabId: 'tab-1', cwd: '/repo', isVisible: false },
        tabId: 'tab-1',
        cwd: '/repo'
      })
    ).toBe(false)
  })

  it('identifies only hidden-to-visible changes as visibility resumes', () => {
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: null, isVisible: true })).toBe(false)
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: true, isVisible: true })).toBe(false)
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: true, isVisible: false })).toBe(
      false
    )
    expect(isTerminalPaneVisibilityResume({ previousIsVisible: false, isVisible: true })).toBe(true)
  })
})
