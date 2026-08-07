import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { createActivityThreadLinkClick } from './activity-thread-link-click'

const { resolveNativeChatFileLinkContextMock, resolveNativeChatFileLinkMock } = vi.hoisted(() => ({
  resolveNativeChatFileLinkContextMock: vi.fn(),
  resolveNativeChatFileLinkMock: vi.fn()
}))

vi.mock('@/components/native-chat/native-chat-file-link', () => ({
  resolveNativeChatFileLink: resolveNativeChatFileLinkMock,
  resolveNativeChatFileLinkContext: resolveNativeChatFileLinkContextMock
}))

const { openDetectedFilePathMock } = vi.hoisted(() => ({
  openDetectedFilePathMock: vi.fn()
}))

vi.mock('@/components/terminal-pane/terminal-file-open-routing', () => ({
  openDetectedFilePath: openDetectedFilePathMock
}))

const openUrlMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  resolveNativeChatFileLinkContextMock.mockReset()
  resolveNativeChatFileLinkMock.mockReset()
  openDetectedFilePathMock.mockReset()
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: true },
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock,
    repos: [],
    projects: [],
    worktreesByRepo: {},
    allWorktrees: vi.fn(() => []),
    workspacePortScan: null,
    workspacePortScansByKey: {}
  }))
  vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeEvent(shiftKey = false): {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
  shiftKey: boolean
} {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    shiftKey
  }
}

function invoke(
  handler: CommentMarkdownLinkClickHandler,
  event: ReturnType<typeof makeEvent>,
  href: string | undefined
): void {
  handler(event as unknown as Parameters<CommentMarkdownLinkClickHandler>[0], href)
}

describe('createActivityThreadLinkClick', () => {
  it('routes http links through openHttpLink so the hosting worktree is foregrounded', () => {
    const handler = createActivityThreadLinkClick({ worktreeId: 'wt-1', tabId: 'tab-1' })
    const event = makeEvent()

    invoke(handler, event, 'https://example.com/')

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(openDetectedFilePathMock).not.toHaveBeenCalled()
  })

  it('keeps http links out of Orca when openLinksInApp is off', () => {
    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInApp: false },
      setActiveWorktree: setActiveWorktreeMock,
      createBrowserTab: createBrowserTabMock,
      repos: [],
      projects: [],
      worktreesByRepo: {},
      allWorktrees: vi.fn(() => []),
      workspacePortScan: null,
      workspacePortScansByKey: {}
    }))
    const handler = createActivityThreadLinkClick({ worktreeId: 'wt-1', tabId: 'tab-1' })

    invoke(handler, makeEvent(), 'https://example.com/')

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens file links in their worktree like native chat does', () => {
    resolveNativeChatFileLinkContextMock.mockReturnValue({
      worktreeId: 'wt-1',
      worktreePath: '/repo/wt-1',
      runtimeEnvironmentId: null
    })
    resolveNativeChatFileLinkMock.mockReturnValue({
      absolutePath: '/repo/wt-1/src/main.ts',
      line: 10,
      column: null
    })
    const handler = createActivityThreadLinkClick({ worktreeId: 'wt-1', tabId: 'tab-1' })
    const event = makeEvent()

    invoke(handler, event, 'file:///repo/wt-1/src/main.ts')

    expect(openDetectedFilePathMock).toHaveBeenCalledWith(
      '/repo/wt-1/src/main.ts',
      10,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', worktreePath: '/repo/wt-1' })
    )
    expect(event.preventDefault).toHaveBeenCalled()
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('ignores non-file, non-http links without consuming the click', () => {
    const handler = createActivityThreadLinkClick({ worktreeId: 'wt-1', tabId: 'tab-1' })
    const event = makeEvent()

    invoke(handler, event, 'mailto:someone@example.com')

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(openDetectedFilePathMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
