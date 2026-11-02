import '../../src/main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import type * as childProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { RpcDispatcher } from '../../src/main/runtime/rpc/dispatcher'
import { WORKTREE_METHODS } from '../../src/main/runtime/rpc/methods/worktree'
import type { WorkspaceStatusDefinition } from '../../src/shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUSES, getWorkspaceStatus } from '../../src/shared/workspace-statuses'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('../../src/cli/runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('../../src/cli/index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})
vi.mock('../../src/cli/runtime/environments', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironmentFromPairingCodeMock,
  listEnvironments: mocks.listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))
vi.mock('child_process', async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>()
  const { createChildProcessModuleMock } = await import('../../src/cli/index-test-harness.js')
  return { ...original, ...(await createChildProcessModuleMock(mocks.spawnMock)) }
})

import { main } from '../../src/cli/index'
import { buildWorktree, okFixture } from '../../src/cli/test-fixtures'
import { useWorktreeAwarenessEnvironment } from '../../src/cli/index-test-harness'

const CUSTOM_STATUSES: WorkspaceStatusDefinition[] = [
  { id: 'ready', label: 'Ready', color: 'neutral', icon: 'circle' },
  { id: 'shipped', label: 'Shipped', color: 'emerald', icon: 'circle-check' }
]

function fixture(
  options: {
    statuses?: readonly WorkspaceStatusDefinition[]
    failRead?: boolean
    hostId?: string
  } = {}
) {
  const stored = {
    ...buildWorktree('/tmp/repo/child', 'feature/child'),
    hostId: options.hostId ?? 'local',
    workspaceStatus: 'in-progress'
  }
  const getUIState = vi.fn(() => {
    if (options.failRead) {
      throw new Error('runtime_unavailable')
    }
    return { workspaceStatuses: options.statuses }
  })
  const updateManagedWorktreeMeta = vi.fn(async (_selector, updates) => {
    if (updates.workspaceStatus !== undefined) {
      stored.workspaceStatus = updates.workspaceStatus
    }
    return stored
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the explicit registry only calls these runtime methods; all data is in memory.
  const runtime = {
    getRuntimeId: () => 'owner-runtime',
    getUIState,
    updateManagedWorktreeMeta
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  mocks.callMock.mockImplementation(async (method, params) => {
    expect(method).toBe('worktree.set')
    return dispatcher.dispatch({ id: 'fixture', authToken: 'tok', method, params })
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  return { stored, getUIState, updateManagedWorktreeMeta, log, error }
}

async function setStatus(status: string | undefined, json: boolean) {
  await main(
    [
      'worktree',
      'set',
      '--worktree',
      'id:repo::/tmp/repo/child',
      ...(status === undefined
        ? ['--comment', 'unchanged status']
        : ['--workspace-status', status]),
      ...(json ? ['--json'] : [])
    ],
    '/tmp/repo'
  )
}

describe('workspace status warnings through CLI and owning RPC handler', () => {
  useWorktreeAwarenessEnvironment(mocks)

  it.each([false, true])('warns about the default fallback with json=%s', async (json) => {
    const { stored, log, error } = fixture()
    await setStatus('done', json)
    expect(stored.workspaceStatus).toBe('done')
    expect(getWorkspaceStatus(stored, DEFAULT_WORKSPACE_STATUSES)).toBe('in-progress')
    const warning = {
      code: 'UNKNOWN_WORKSPACE_STATUS',
      message: expect.stringContaining('Unknown workspace status "done"'),
      details: {
        requestedId: 'done',
        effectiveId: 'in-progress',
        validIds: ['todo', 'in-progress', 'in-review', 'completed']
      }
    }
    const output = log.mock.calls.flat().join('\n')
    if (json) {
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        result: { worktree: { workspaceStatus: 'done' }, warnings: [warning] }
      })
      expect(output).toContain('In progress')
      expect(error).not.toHaveBeenCalled()
    } else {
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Unknown workspace status "done"'))
      const text = error.mock.calls.flat().join('\n')
      expect(text).toContain('In progress')
      expect(text).toContain('todo, in-progress, in-review, completed')
    }
  })

  it.each(['ssh:build-box', 'runtime:paired-owner'])(
    'uses %s owner columns for unknown ids',
    async (hostId) => {
      const { stored, log } = fixture({ statuses: CUSTOM_STATUSES, hostId })
      await setStatus('done', true)
      expect(getWorkspaceStatus(stored, CUSTOM_STATUSES)).toBe('ready')
      expect(JSON.parse(log.mock.calls.flat().join('\n'))).toMatchObject({
        ok: true,
        result: {
          warnings: [
            {
              details: { requestedId: 'done', effectiveId: 'ready', validIds: ['ready', 'shipped'] }
            }
          ]
        }
      })
      expect(log.mock.calls.flat().join('\n')).toContain('Ready')
      expect(mocks.callMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['completed', 'shipped'])('accepts valid column %s without warnings', async (status) => {
    const { stored, log, error } = fixture({
      statuses: status === 'shipped' ? CUSTOM_STATUSES : undefined
    })
    await setStatus(status, true)
    expect(stored.workspaceStatus).toBe(status)
    const response = JSON.parse(log.mock.calls.flat().join('\n'))
    expect(response).toMatchObject({ ok: true, result: { worktree: { workspaceStatus: status } } })
    expect(response.result).not.toHaveProperty('warnings')
    expect(error).not.toHaveBeenCalled()
  })

  it('preserves the completed write when owner settings cannot be read', async () => {
    const { stored, log, error } = fixture({ failRead: true })
    await setStatus('done', true)
    expect(stored.workspaceStatus).toBe('done')
    const response = JSON.parse(log.mock.calls.flat().join('\n'))
    expect(response).toMatchObject({ ok: true })
    expect(response.result).not.toHaveProperty('warnings')
    expect(error).not.toHaveBeenCalled()
  })

  it('skips the settings read when the status is unchanged', async () => {
    const { getUIState, stored } = fixture({ failRead: true })
    await setStatus(undefined, true)
    expect(getUIState).not.toHaveBeenCalled()
    expect(stored.workspaceStatus).toBe('in-progress')
  })

  it('keeps an older host response without warnings working', async () => {
    const { stored, log, error } = fixture()
    mocks.callMock.mockResolvedValue(
      okFixture('old-host', { worktree: { ...stored, workspaceStatus: 'done' } })
    )
    await setStatus('done', true)
    expect(JSON.parse(log.mock.calls.flat().join('\n'))).toMatchObject({
      ok: true,
      result: { worktree: { workspaceStatus: 'done' } }
    })
    expect(error).not.toHaveBeenCalled()
    expect(mocks.callMock).toHaveBeenCalledTimes(1)
  })
})
