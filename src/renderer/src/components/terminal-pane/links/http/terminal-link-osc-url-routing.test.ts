import { describe, expect, it, vi } from 'vitest'

import { handleOscLink } from '../terminal-osc-link-routing'
import { createTerminalLinkTestDoubles } from '../terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from '../terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openUrlMock, createBrowserTabMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('waits for the first-use preference before routing terminal http links', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false, openLinksInAppPreferencePrompted: false }
    const requestOpenLinksInAppPreference = vi.fn(async () => {
      storeState.settings = { openLinksInApp: true, openLinksInAppPreferencePrompted: true }
      return true
    })

    handleOscLink(
      'https://example.com',
      { metaKey: true, ctrlKey: false, shiftKey: false },
      { ...deps, requestOpenLinksInAppPreference }
    )

    expect(requestOpenLinksInAppPreference).toHaveBeenCalledWith('https://example.com/')
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()

    await flushAsyncWork()

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})
