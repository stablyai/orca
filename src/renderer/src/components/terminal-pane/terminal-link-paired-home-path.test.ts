import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, runtimeEnvironmentCallMock, statMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

const VIDEO = '~/work/project-rh/guides/presentation.mp4'
const HOST_VIDEO = '/data/m/work/project-rh/guides/presentation.mp4'

function hostHoldsVideoInSibling(): void {
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'rpc-1',
    ok: true,
    result: {
      worktree: 'wt-b',
      relativePath: 'guides/presentation.mp4',
      absolutePath: HOST_VIDEO,
      exists: true,
      isDirectory: false
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

function provideLinks(worktreePath: string, text = `Saved ${VIDEO}`): Promise<ILink[]> {
  const { provider } = createProviderSetup([makeBufferLine(text)], new Map(), {
    worktreePath,
    startupCwd: worktreePath,
    runtimeEnvironmentId: 'env-1',
    getRuntimeTerminalHandleForPane: () => 'term-1'
  })
  return new Promise<ILink[]>((resolve) => {
    provider.provideLinks(1, (links) => resolve(links ?? []))
  })
}

function hostWasAskedFor(): unknown[] {
  return runtimeEnvironmentCallMock.mock.calls
    .map(([request]) => request)
    .filter((request) => request?.method === 'files.resolveTerminalPath')
    .map((request) => request.params?.pathText)
}

// Why: only the server knows its home; the cwd says nothing reliable about it.
describe('a home-relative path printed in a paired-server terminal', () => {
  it('links through the host even when the cwd hides where home is', async () => {
    hostHoldsVideoInSibling()

    const links = await provideLinks('/data/m/work/project')

    expect(links.map((link) => link.text)).toEqual([VIDEO])
    expect(hostWasAskedFor()).toEqual([VIDEO])
  })

  it('never substitutes a home guessed from the cwd for the host’s own', async () => {
    hostHoldsVideoInSibling()

    await provideLinks('/home/m/work/project')

    expect(hostWasAskedFor()).toEqual([VIDEO])
  })

  async function click(link: ILink): Promise<void> {
    // Why a prototype-less object: node has no MouseEvent; activation reads only these fields.
    const event: MouseEvent = Object.assign(Object.create(null), {
      metaKey: true,
      ctrlKey: true,
      button: 0,
      preventDefault: vi.fn()
    })
    link.activate(event, link.text)
    await flushDoubleRaf()
  }

  it('opens the file in the workspace the host says holds it', async () => {
    hostHoldsVideoInSibling()
    const links = await provideLinks('/data/m/work/project')

    await click(links[0]!)

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: HOST_VIDEO,
        relativePath: 'guides/presentation.mp4',
        worktreeId: 'wt-b'
      }),
      { forceContentReload: true }
    )
  })

  it.each(['~/work/project-rh', '~/work/project-rh/'])(
    'switches to the workspace %s names, as an absolute root link does',
    async (rootText) => {
      runtimeEnvironmentCallMock.mockResolvedValue({
        id: 'rpc-1',
        ok: true,
        result: {
          worktree: 'wt-b',
          relativePath: '',
          absolutePath: '/data/m/work/project-rh',
          exists: true,
          isDirectory: true
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
      const links = await provideLinks('/data/m/work/project', `cd ${rootText}`)
      expect(links.map((link) => link.text)).toEqual([rootText])

      await click(links[0]!)

      expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-b', {
        executionHostId: 'runtime:env-1'
      })
      expect(openFileMock).not.toHaveBeenCalled()
    }
  )

  it('shows no link for a home path its host lacks, without asking this computer', async () => {
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: HOST_VIDEO,
        exists: false,
        isDirectory: false
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(await provideLinks('/data/m/work/project')).toEqual([])
    expect(statMock).not.toHaveBeenCalled()
  })

  it('keeps expanding home on this client for a WSL workspace', async () => {
    hostHoldsVideoInSibling()

    await provideLinks('\\\\wsl.localhost\\Ubuntu\\home\\me\\project')

    expect(hostWasAskedFor()).not.toContain(VIDEO)
  })
})
