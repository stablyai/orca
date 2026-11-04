import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { placeAbsoluteTab } from './absolute-tab-placement'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import {
  SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE,
  TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES,
  TERMINAL_PATH_IN_PLACE_FILES_RUNTIME_CAPABILITY
} from '../../../../shared/runtime-file-contracts'

const mocks = vi.hoisted(() => ({
  findWorkspaceFileRoute: vi.fn(),
  supportsCapability: vi.fn(),
  grantRestoredHostFile: vi.fn()
}))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: mocks.findWorkspaceFileRoute
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))
vi.mock('./restored-host-file-grant', () => ({
  grantRestoredHostFile: mocks.grantRestoredHostFile
}))

const FILE = '/repo-b/docs/readme.md'
const HOLDER = { worktreeId: 'repo-b', relativePath: 'docs/readme.md' } as const
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the mocked findWorkspaceFileRoute receives it
const state = {} as AppState
const serverTab = {
  state,
  worktreeId: 'repo-a',
  tab: { worktreeId: 'repo-a', filePath: FILE },
  executionHostId: 'runtime:env-1',
  readTarget: { kind: 'environment', environmentId: 'env-1' },
  runtimeEnvironmentId: 'env-1'
} as const

beforeEach(() => {
  mocks.findWorkspaceFileRoute.mockReset()
  mocks.supportsCapability.mockReset().mockResolvedValue(true)
  mocks.grantRestoredHostFile
    .mockReset()
    .mockResolvedValue({ grantId: 'g-1', readOnly: false, byteLength: 1024 })
})

describe('an absolute-path tab whose file another workspace holds', () => {
  it('stays in its workspace through a grant on a server that saves grants', async () => {
    mocks.findWorkspaceFileRoute.mockReturnValue({ ...HOLDER, executionHostId: 'runtime:env-1' })

    await expect(placeAbsoluteTab(serverTab)).resolves.toMatchObject({
      kind: 'grant',
      grantId: 'g-1',
      readOnly: false
    })
    expect(mocks.grantRestoredHostFile).toHaveBeenCalledWith(
      serverTab.readTarget,
      'repo-a',
      FILE,
      undefined
    )
    expect(mocks.supportsCapability).toHaveBeenCalledWith(
      'env-1',
      TERMINAL_PATH_IN_PLACE_FILES_RUNTIME_CAPABILITY,
      15_000
    )
  })

  it('keeps reading through the grant it already holds', async () => {
    mocks.findWorkspaceFileRoute.mockReturnValue({ ...HOLDER, executionHostId: 'runtime:env-1' })

    await expect(
      placeAbsoluteTab({ ...serverTab, tab: { ...serverTab.tab, terminalArtifactGrantId: 'g-0' } })
    ).resolves.toEqual({ kind: 'read' })
    expect(mocks.grantRestoredHostFile).not.toHaveBeenCalled()
  })

  it.each([
    ['predates in-place files', () => mocks.supportsCapability.mockResolvedValue(false)],
    [
      'grants a file too large to save through a grant',
      () =>
        mocks.grantRestoredHostFile.mockResolvedValue({
          grantId: 'g-1',
          readOnly: false,
          byteLength: TERMINAL_ARTIFACT_IN_PLACE_MAX_BYTES + 1
        })
    ],
    [
      'grants a binary file its bytes editors need the workspace for',
      () =>
        mocks.grantRestoredHostFile.mockResolvedValue({
          grantId: 'g-1',
          readOnly: false,
          byteLength: 1024,
          binary: true
        })
    ],
    [
      'refuses a grant outside its SSH workspaces',
      () =>
        mocks.grantRestoredHostFile.mockRejectedValue(
          new RuntimeRpcCallError({
            id: 'r',
            ok: false,
            error: { code: 'runtime_error', message: SSH_OUTSIDE_WORKSPACE_UNSUPPORTED_MESSAGE },
            _meta: { runtimeId: 'host' }
          })
        )
    ]
  ])('moves to the holding workspace when the server %s', async (_label, arrange) => {
    const route = { ...HOLDER, executionHostId: 'runtime:env-1' }
    mocks.findWorkspaceFileRoute.mockReturnValue(route)
    arrange()

    await expect(placeAbsoluteTab(serverTab)).resolves.toEqual({ kind: 'move', route })
  })

  it.each([
    ['an unreachable host', () => mocks.supportsCapability.mockRejectedValue(new Error('offline'))],
    [
      'a timed-out grant',
      () => mocks.grantRestoredHostFile.mockRejectedValue(new Error('offline'))
    ],
    [
      'a host that times out',
      () =>
        mocks.grantRestoredHostFile.mockRejectedValue(
          new RuntimeRpcCallError({
            id: 'r',
            ok: false,
            error: { code: 'runtime_timeout', message: 'offline' },
            _meta: { runtimeId: 'host' }
          })
        )
    ],
    [
      'a passing file error on the host',
      () =>
        mocks.grantRestoredHostFile.mockRejectedValue(
          new RuntimeRpcCallError({
            id: 'r',
            ok: false,
            error: { code: 'runtime_error', message: 'offline: EIO' },
            _meta: { runtimeId: 'host' }
          })
        )
    ]
  ])('fails retryably instead of moving the tab for %s', async (_label, arrange) => {
    mocks.findWorkspaceFileRoute.mockReturnValue({ ...HOLDER, executionHostId: 'runtime:env-1' })
    arrange()

    // Why: a move re-keys the tab into the other workspace for good.
    await expect(placeAbsoluteTab(serverTab)).rejects.toThrow('offline')
  })

  it('reads a local file in place', async () => {
    mocks.findWorkspaceFileRoute.mockReturnValue({ ...HOLDER, executionHostId: 'local' })

    await expect(
      placeAbsoluteTab({
        ...serverTab,
        executionHostId: 'local',
        readTarget: { kind: 'local' },
        runtimeEnvironmentId: undefined
      })
    ).resolves.toEqual({ kind: 'read' })
    expect(mocks.grantRestoredHostFile).not.toHaveBeenCalled()
  })
})

describe('an absolute-path tab whose file no other workspace takes', () => {
  it("re-owns in place when a conflict review loads the tab's own workspace file", async () => {
    const route = { worktreeId: 'folder:pkg', relativePath: 'a.md', executionHostId: 'local' }
    mocks.findWorkspaceFileRoute.mockReturnValue(route)

    await expect(
      placeAbsoluteTab({
        ...serverTab,
        worktreeId: 'repo-a',
        tab: { worktreeId: 'folder:pkg', filePath: '/repo-a/pkg/a.md' },
        executionHostId: 'local',
        readTarget: { kind: 'local' },
        runtimeEnvironmentId: undefined
      })
    ).resolves.toEqual({ kind: 'move', route })
  })

  it('asks its server for a grant when the file is outside every workspace', async () => {
    mocks.findWorkspaceFileRoute.mockReturnValue(null)

    await expect(placeAbsoluteTab(serverTab)).resolves.toMatchObject({ kind: 'grant' })
    expect(mocks.supportsCapability).not.toHaveBeenCalled()
  })

  it('surfaces a refused grant for a file outside every workspace', async () => {
    mocks.findWorkspaceFileRoute.mockReturnValue(null)
    mocks.grantRestoredHostFile.mockRejectedValue(new Error('unavailable'))

    await expect(placeAbsoluteTab(serverTab)).rejects.toThrow('unavailable')
  })
})
