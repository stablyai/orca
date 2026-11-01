import { describe, expect, it, vi } from 'vitest'

import { handleOscLink } from './terminal-osc-link-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openUrlMock, createBrowserTabMock, setActiveWorktreeMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('ignores http links without the platform modifier on desktop', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }
    const preventDefault = vi.fn()

    expect(
      handleOscLink('https://example.com', { metaKey: false, ctrlKey: false, preventDefault }, deps)
    ).toBe(false)

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('routes http links with the platform modifier on desktop', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }
    const preventDefault = vi.fn()

    expect(
      handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, preventDefault }, deps)
    ).toBe(true)

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('does not steal macOS ctrl-click context-menu gestures for OSC links', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }
    const preventDefault = vi.fn()

    handleOscLink(
      'https://example.com',
      {
        button: 0,
        metaKey: false,
        ctrlKey: true,
        preventDefault
      },
      deps
    )

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('routes to the system browser when openLinksInApp is off', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    handleOscLink(
      'https://example.com',
      { metaKey: true, ctrlKey: false, shiftKey: false, preventDefault, stopPropagation },
      deps
    )

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
    // Let mouseup bubble so xterm SelectionService detaches drag listeners; stopping it causes phantom selections after link clicks.
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('defaults to the system browser when settings have not hydrated yet', () => {
    setPlatform('Macintosh')
    storeState.settings = undefined

    handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, shiftKey: false }, deps)

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

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

  it('uses the system browser for shift+cmd/ctrl+click even when Orca browser tabs are enabled', () => {
    setPlatform('Windows')
    storeState.settings = { openLinksInApp: true }

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: true, shiftKey: true }, deps)

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when no worktree owns the terminal pane', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }

    handleOscLink(
      'https://example.com',
      { metaKey: true, ctrlKey: false, shiftKey: false },
      { worktreeId: '', worktreePath: '/tmp' }
    )

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
