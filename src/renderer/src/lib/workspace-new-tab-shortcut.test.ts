import { describe, expect, it, vi } from 'vitest'
import { getWebAiAccountWorkspaceId, WEB_AI_BROWSER_WORKSPACE_ID } from '../../../shared/constants'
import { dispatchWorkspaceNewTabShortcut } from './workspace-new-tab-shortcut'

describe('dispatchWorkspaceNewTabShortcut', () => {
  it.each([getWebAiAccountWorkspaceId('chatgpt-main'), WEB_AI_BROWSER_WORKSPACE_ID])(
    'opens a browser tab for Web AI workspace %s',
    (workspaceId) => {
      const openBrowserTab = vi.fn()
      const openTerminalTab = vi.fn()

      expect(
        dispatchWorkspaceNewTabShortcut(workspaceId, { openBrowserTab, openTerminalTab })
      ).toBe('browser')
      expect(openBrowserTab).toHaveBeenCalledTimes(1)
      expect(openTerminalTab).not.toHaveBeenCalled()
    }
  )

  it('opens a terminal tab for a project workspace', () => {
    const openBrowserTab = vi.fn()
    const openTerminalTab = vi.fn()

    expect(dispatchWorkspaceNewTabShortcut('worktree-1', { openBrowserTab, openTerminalTab })).toBe(
      'terminal'
    )
    expect(openTerminalTab).toHaveBeenCalledTimes(1)
    expect(openBrowserTab).not.toHaveBeenCalled()
  })
})
