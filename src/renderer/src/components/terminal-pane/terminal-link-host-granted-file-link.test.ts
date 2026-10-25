import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, statMock, openFileMock, runtimeEnvironmentCallMock } = doubles

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

const IMAGE = '/tmp/orca-preview.png'

function hostGrants(): void {
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'rpc-1',
    ok: true,
    result: {
      worktree: 'wt-1',
      relativePath: null,
      absolutePath: IMAGE,
      exists: true,
      isDirectory: false,
      openTarget: { kind: 'absolute-file', provider: 'local', absolutePath: IMAGE, grantId: 'g-1' }
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
}

function provideLinks(): Promise<ILink[]> {
  const { provider } = createProviderSetup([makeBufferLine(IMAGE)], new Map(), {
    worktreePath: '/srv/repo',
    startupCwd: '/srv/repo',
    runtimeEnvironmentId: 'env-1',
    getRuntimeTerminalHandleForPane: () => 'term-1'
  })
  return new Promise<ILink[]>((resolve) => {
    provider.provideLinks(1, (links) => resolve(links ?? []))
  })
}

describe('a paired-server terminal path outside its workspace', () => {
  it('links a file the host grants to the terminal that printed it', async () => {
    hostGrants()

    const links = await provideLinks()

    expect(links.map((link) => link.text)).toEqual([IMAGE])
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'files.resolveTerminalPath',
        params: { worktree: 'id:wt-1', pathText: IMAGE, crossWorkspace: true, terminal: 'term-1' }
      })
    )
    // Why: this computer's copy of the path says nothing about the server's.
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  })

  it('opens the linked file through its grant', async () => {
    hostGrants()

    const links = await provideLinks()
    // Why a prototype-less object: node has no MouseEvent; activation reads only these fields.
    const click: MouseEvent = Object.assign(Object.create(null), {
      metaKey: true,
      ctrlKey: true,
      button: 0,
      preventDefault: vi.fn()
    })
    links[0]!.activate(click, IMAGE)
    await flushDoubleRaf()

    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: IMAGE,
        runtimeEnvironmentId: 'env-1',
        readOnly: true,
        terminalArtifactGrantId: 'g-1'
      }),
      { forceContentReload: true }
    )
  })

  it('shows no link for a path the host refuses, even when this computer has it', async () => {
    runtimeEnvironmentCallMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: IMAGE,
        exists: true,
        isDirectory: true
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    expect(await provideLinks()).toEqual([])
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
  })
})
