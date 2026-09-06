import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath, openFilePathLinkAtBufferPosition } from './terminal-link-handlers'
import { getConnectionId } from '@/lib/connection-context'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createProviderSetup,
  makeBuffer,
  makeBufferLine
} from './terminal-link-provider-buffer-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, authorizeExternalPathMock, statMock, openFileMock, openFilePathMock } =
  doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

// Why: the real helper reads worktreesByRepo/activeRepoId/etc. from the store
// and orchestrates side effects that are out of scope for the link-handler
// unit tests. Mock it so these tests only assert on routing (browser tab vs.
// openFile), not on activation internals.
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('handleOscLink', () => {
  it('switches to an exact known worktree root without local auth or stat', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/tmp/other-worktree' }]
    }

    openDetectedFilePath('/tmp/other-worktree', null, null, deps)
    await flushAsyncWork()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('coalesces duplicate known-root activation from provider and mouseup fallback', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/tmp/other-worktree' }]
    }

    openDetectedFilePath('/tmp/other-worktree', null, null, deps)
    openDetectedFilePath('/tmp/other-worktree', null, null, deps)
    await flushAsyncWork()

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('keeps shift+cmd/ctrl-click external open for a known worktree root', async () => {
    setPlatform('Macintosh')
    statMock.mockResolvedValueOnce({ isDirectory: true })
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/tmp/other-worktree' }]
    }

    openDetectedFilePath('/tmp/other-worktree', null, null, {
      ...deps,
      openWithSystemDefault: true
    })
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/tmp/other-worktree'
    })
    expect(statMock).toHaveBeenCalled()
    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/other-worktree')
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('switches to an SSH worktree root from store state without filesystem probing', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/home/me/other-worktree' }]
    }

    openDetectedFilePath('/home/me/other-worktree', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await flushAsyncWork()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('switches to a Windows worktree root when resolved separators differ from store state', async () => {
    setPlatform('Windows')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-win', path: 'C:\\Users\\Alice\\Repo' }]
    }

    openDetectedFilePath('C:/Users/Alice/Repo', null, null, {
      worktreeId: 'wt-1',
      worktreePath: 'C:/Users/Alice/Current'
    })
    await flushAsyncWork()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-win')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('does not fall back to file or directory open if known-root activation fails', async () => {
    setPlatform('Macintosh')
    vi.mocked(activateAndRevealWorktree).mockReturnValueOnce(false)
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/tmp/other-worktree' }]
    }

    openDetectedFilePath('/tmp/other-worktree', null, null, deps)
    await flushAsyncWork()

    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })
})

describe('createFilePathLinkProvider range bounds', () => {
  it('shows switch and external-open hint for known worktree root hover', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-1', path: '/repo' }]
    }
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('/repo')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo (Click for actions, ⌘+click to switch workspace, or ⇧⌘+click to open in Finder)'
    )
  })

  it('shows a known worktree root link even when the exists cache says missing', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-1', path: '/repo' }]
    }
    const { provider, linkTooltip } = createProviderSetup(
      [makeBufferLine('/repo')],
      new Map([['active\0/repo', false]])
    )

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links.map((link) => link.text)).toEqual(['/repo'])
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
    expect(linkTooltip.textContent).toBe(
      '/repo (Click for actions, ⌘+click to switch workspace, or ⇧⌘+click to open in Finder)'
    )
  })

  it('linkifies a known worktree root printed with a trailing slash', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-1', path: '/repo' }]
    }
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('/repo/')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links.map((link) => link.text)).toContain('/repo/')
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo (Click for actions, ⌘+click to switch workspace, or ⇧⌘+click to open in Finder)'
    )
  })

  it('does not advertise external open for SSH worktree root hover', async () => {
    setPlatform('Windows')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-1', path: '/repo' }]
    }
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('/repo')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo (Click for actions or Ctrl+click to switch workspace)'
    )
  })

  it('switches to a known worktree root from direct fallback even when cache says missing', async () => {
    setPlatform('Macintosh')
    storeState.worktreesByRepo = {
      repo: [{ id: 'wt-2', path: '/tmp/other-worktree' }]
    }

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/tmp/other-worktree')]),
      { x: 5, y: 1 },
      80,
      {
        startupCwd: '/tmp',
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        runtimeEnvironmentId: null,
        pathExistsCache: new Map([['active\0/tmp/other-worktree', false]])
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-2')
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })
})
