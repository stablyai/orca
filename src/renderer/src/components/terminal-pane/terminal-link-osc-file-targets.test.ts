import { describe, expect, it, vi } from 'vitest'
import { handleOscLink } from './terminal-osc-link-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  deps,
  authorizeExternalPathMock,
  openFileMock,
  openFilePathMock,
  setPendingEditorRevealMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('ignores local file URL links without the platform modifier on desktop', async () => {
    setPlatform('Windows')

    expect(handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false }, deps)).toBe(
      false
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens local file URL links in Orca with the platform modifier on desktop', async () => {
    setPlatform('Windows')

    expect(handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true }, deps)).toBe(
      true
    )

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    // before asserting on positive behavior.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' }),
      { forceContentReload: true }
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens Windows absolute OSC link targets that parse as URL schemes', async () => {
    setPlatform('Windows')

    handleOscLink(
      'C:\\repo\\src\\index.ts:12:3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        startupCwd: 'C:\\repo',
        worktreePath: 'C:\\repo'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: 'C:/repo/src/index.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'C:/repo/src/index.ts' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: 'C:/repo/src/index.ts',
      fileId: 'C:/repo/src/index.ts',
      line: 12,
      column: 3,
      matchLength: 0
    })
  })

  it('opens Windows UNC file URL links from Windows worktrees', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://server/share/repo/test.txt',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '\\\\server\\share\\repo'
      }
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '//server/share/repo/test.txt'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '//server/share/repo/test.txt' }),
      { forceContentReload: true }
    )
  })

  it('rejects hosted file URL links when the active worktree is not Windows-local', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://server/share/repo/test.txt',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '/home/user/repo'
      }
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens #L file URL links in Orca and preserves anchors', async () => {
    setPlatform('Macintosh')

    handleOscLink('file:///tmp/test.txt#L42', { metaKey: true, ctrlKey: false }, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/test.txt',
      fileId: '/tmp/test.txt',
      line: 42,
      column: 1,
      matchLength: 0
    })
  })

  it('opens file URL links with the system default app for shift+cmd/ctrl-click', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      'file:///tmp/test.txt#L42',
      { metaKey: true, ctrlKey: false, shiftKey: true },
      deps
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/test.txt')
    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
  })

  it('preserves trailing line and column suffixes when shift+cmd/ctrl-click native open falls back', async () => {
    setPlatform('Macintosh')
    openFilePathMock.mockResolvedValueOnce(false)

    handleOscLink(
      'file:///tmp/test.txt:42:7',
      { metaKey: true, ctrlKey: false, shiftKey: true },
      deps
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/test.txt',
      fileId: '/tmp/test.txt',
      line: 42,
      column: 7,
      matchLength: 0
    })
  })

  it('opens UNC file URL links with line and column anchors', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://Server/Share/Repo/src/app.ts#L12C3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '//Server/Share/Repo'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '//server/Share/Repo/src/app.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '//server/Share/Repo/src/app.ts',
        relativePath: 'src/app.ts'
      }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '//server/Share/Repo/src/app.ts',
      fileId: '//server/Share/Repo/src/app.ts',
      line: 12,
      column: 3,
      matchLength: 0
    })
  })

  it('opens relative OSC file links against the terminal cwd', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      'docs/README.md',
      { metaKey: true, ctrlKey: false },
      {
        ...deps,
        startupCwd: '/tmp/project'
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/tmp/project/docs/README.md'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/project/docs/README.md',
        relativePath: 'project/docs/README.md'
      }),
      { forceContentReload: true }
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('maps POSIX OSC file links for a WSL worktree before opening them', async () => {
    setPlatform('Windows')

    handleOscLink(
      '/root/workspace/myrepo/README.md:5:3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        startupCwd: '/root/workspace/myrepo',
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
        wslDistro: 'Ubuntu'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
      }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      fileId: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      line: 5,
      column: 3,
      matchLength: 0
    })
  })

  it('maps file URL OSC links for a WSL worktree before opening them', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file:///root/workspace/myrepo/README.md#L5C3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
        wslDistro: 'Ubuntu'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
      }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      fileId: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      line: 5,
      column: 3,
      matchLength: 0
    })
  })

  it('opens tilde OSC file links against explicit terminal home when cwd is outside home', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      '~/file.ts',
      { metaKey: true, ctrlKey: false },
      {
        ...deps,
        startupCwd: '/workspace/project',
        terminalHomePath: '/home/alice'
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/home/alice/file.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/alice/file.ts'
      }),
      { forceContentReload: true }
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })
})
