import { describe, expect, it, vi } from 'vitest'
import { SPLIT_TERMINAL_PANE_EVENT, type SplitTerminalPaneDetail } from '@/constants/terminal'
import { registerTerminalPaneSplitEventListener } from './use-terminal-pane-lifecycle'

describe('terminal pane split event ownership', () => {
  it('lets only the newest overlapping mount own split events for a tab', () => {
    const target = new EventTarget()
    const tabId = 'tab-grid'
    const firstMount = vi.fn()
    const replacementMount = vi.fn()
    const unregisterFirst = registerTerminalPaneSplitEventListener(target, tabId, firstMount)
    const unregisterReplacement = registerTerminalPaneSplitEventListener(
      target,
      tabId,
      replacementMount
    )
    const event = new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, {
      detail: {
        tabId,
        paneRuntimeId: 1,
        direction: 'vertical'
      }
    })

    target.dispatchEvent(event)

    expect(firstMount).not.toHaveBeenCalled()
    expect(replacementMount).toHaveBeenCalledOnce()

    unregisterFirst()
    target.dispatchEvent(event)
    expect(replacementMount).toHaveBeenCalledTimes(2)

    unregisterReplacement()
    target.dispatchEvent(event)
    expect(replacementMount).toHaveBeenCalledTimes(2)
  })
})
