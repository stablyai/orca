import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleOscLink, isTerminalLinkActivation } from './terminal-link-handlers'

const openUrlMock = vi.fn()
const openFileUriMock = vi.fn()
const openFileMock = vi.fn()
const authorizeExternalPathMock = vi.fn()
const statMock = vi.fn().mockResolvedValue({ isDirectory: false })

const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      setActiveWorktree: vi.fn(),
      openFile: openFileMock
    })
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'plaintext'
}))

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock
      },
      fs: {
        authorizeExternalPath: authorizeExternalPathMock,
        stat: statMock
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTerminalLinkActivation', () => {
  it('requires cmd on macOS', () => {
    setPlatform('Macintosh')

    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })

  it('requires ctrl on non-macOS platforms', () => {
    setPlatform('Windows')

    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })
})

describe('handleOscLink', () => {
  it('opens http links only when the platform modifier is pressed', () => {
    setPlatform('Macintosh')

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: false }, deps)
    expect(openUrlMock).not.toHaveBeenCalled()

    handleOscLink('https://example.com', { metaKey: true, ctrlKey: false }, deps)
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
  })

  it('opens file links in Orca instead of via shell when the platform modifier is pressed', async () => {
    setPlatform('Windows')

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false }, deps)
    // Without modifier, nothing happens
    expect(openFileUriMock).not.toHaveBeenCalled()

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true }, deps)
    // Should NOT call shell.openFileUri (which opens system default editor)
    expect(openFileUriMock).not.toHaveBeenCalled()

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    // before asserting on positive behavior.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' })
    )
  })
})
