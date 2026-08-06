import type * as React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import { handleNativeChatLinkClick } from './use-native-chat-link-click'

const mocks = vi.hoisted(() => ({
  openDetectedFilePath: vi.fn(),
  openTerminalHttpLink: vi.fn()
}))

vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: mocks.openDetectedFilePath
}))

vi.mock('@/components/terminal-pane/terminal-url-link-hit-testing', () => ({
  openTerminalHttpLink: mocks.openTerminalHttpLink
}))

const fileContext: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo/worktree',
  runtimeEnvironmentId: null
}

function clickEvent(shiftKey = false): React.MouseEvent<HTMLElement> {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    shiftKey
  } as unknown as React.MouseEvent<HTMLElement>
}

describe('handleNativeChatLinkClick', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('routes local HTTP links through the terminal link policy', () => {
    const requestOpenLinksInAppPreference = vi.fn(() => null)
    const event = clickEvent()

    handleNativeChatLinkClick(event, 'https://example.com/docs', {
      fileContext,
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      requestOpenLinksInAppPreference
    })

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(mocks.openTerminalHttpLink).toHaveBeenCalledWith('https://example.com/docs', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'local' },
      modifierHeld: false,
      requestOpenLinksInAppPreference
    })
  })

  it('preserves runtime ownership and the Shift routing override', () => {
    const event = clickEvent(true)

    handleNativeChatLinkClick(event, 'http://localhost:3000', {
      fileContext: { ...fileContext, runtimeEnvironmentId: 'runtime-1' },
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'runtime-1'
    })

    expect(mocks.openTerminalHttpLink).toHaveBeenCalledWith('http://localhost:3000', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'runtime-1' },
      modifierHeld: true,
      requestOpenLinksInAppPreference: undefined
    })
  })

  it('keeps file links on the native chat file-opening path', () => {
    const event = clickEvent()

    handleNativeChatLinkClick(event, 'src/main.ts#L12', {
      fileContext,
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null
    })

    expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
      '/repo/worktree/src/main.ts',
      12,
      null,
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo/worktree',
        runtimeEnvironmentId: null,
        openWithSystemDefault: false
      }
    )
    expect(mocks.openTerminalHttpLink).not.toHaveBeenCalled()
  })

  it('leaves non-HTTP web links to their existing external handler', () => {
    const event = clickEvent()

    handleNativeChatLinkClick(event, 'mailto:dev@example.com', {
      fileContext,
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null
    })

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
    expect(mocks.openTerminalHttpLink).not.toHaveBeenCalled()
  })
})
