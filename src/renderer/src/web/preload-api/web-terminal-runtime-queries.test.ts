import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalListParams } from '../../../../shared/rpc-contract/terminal/terminal-unary-params'
import { createRuntimePtyQueryApi } from './web-terminal-runtime-queries'

const { callEnvironmentEnvelope, requireActiveEnvironment } = vi.hoisted(() => ({
  callEnvironmentEnvelope: vi.fn(),
  requireActiveEnvironment: vi.fn(() => ({ id: 'selected-environment' }))
}))
vi.mock('./web-runtime-calls', () => ({ callEnvironmentEnvelope }))
vi.mock('./web-runtime-session', () => ({ requireActiveEnvironment }))

const completeScope = { hostIds: ['local'], omittedHostIds: [] }

function success(result: unknown) {
  return { id: 'query', ok: true as const, result, _meta: { runtimeId: 'host-runtime' } }
}

describe('terminal queries across execution hosts', () => {
  beforeEach(() => {
    callEnvironmentEnvelope.mockReset()
    requireActiveEnvironment.mockReset().mockReturnValue({ id: 'selected-environment' })
  })

  it('batches snapshot capability queries by owner, preserving order and host failures', async () => {
    callEnvironmentEnvelope.mockImplementation(async (environmentId: string) => {
      if (environmentId === 'unreachable') {
        throw new Error('host disconnected')
      }
      return success({
        terminals: [{ handle: 'same-handle', ptyId: environmentId === 'local' ? 'pty-1' : null }],
        truncated: false,
        hostScope: completeScope
      })
    })
    const ids = [
      'remote:local@@same-handle',
      'remote:ssh@@same-handle',
      'remote:unreachable@@same-handle',
      'remote:local@@same-handle'
    ]

    await expect(
      createRuntimePtyQueryApi().getAuthoritativeBufferSnapshotCapabilities(ids)
    ).resolves.toEqual(
      ids.map((id, index) => ({
        id,
        authoritative: index === 2 ? null : index !== 1
      }))
    )
    expect(callEnvironmentEnvelope).toHaveBeenCalledTimes(3)
    expect(requireActiveEnvironment).not.toHaveBeenCalled()
  })

  it('keeps large capability queries within the existing 64-handle wire contract', async () => {
    callEnvironmentEnvelope.mockImplementation(
      async (_owner: string, _method: string, params: unknown) => {
        const parsed = TerminalListParams.parse(params)
        return success({
          terminals: parsed.handles?.map((handle) => ({ handle, ptyId: `pty-${handle}` })),
          truncated: false,
          hostScope: completeScope
        })
      }
    )
    const ids = Array.from({ length: 130 }, (_, index) => `remote:owner@@term-${index}`)

    await expect(
      createRuntimePtyQueryApi().getAuthoritativeBufferSnapshotCapabilities(ids)
    ).resolves.toEqual(ids.map((id) => ({ id, authoritative: true })))
    expect(callEnvironmentEnvelope).toHaveBeenCalledTimes(3)
    expect(
      callEnvironmentEnvelope.mock.calls.map(
        ([, , params]) => TerminalListParams.parse(params).handles?.length
      )
    ).toEqual([64, 64, 2])
  })

  it.each([
    { terminals: [], truncated: false },
    { terminals: [], truncated: true, hostScope: completeScope },
    { terminals: [], truncated: false, hostScope: { hostIds: [], omittedHostIds: [] } },
    {
      terminals: [],
      truncated: false,
      hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box'] }
    }
  ])('does not infer death from incomplete inventory: %j', async (inventory) => {
    callEnvironmentEnvelope.mockResolvedValue(success(inventory))
    const api = createRuntimePtyQueryApi()
    const id = 'remote:owner@@missing'

    await expect(api.hasPty(id)).resolves.toBeNull()
    await expect(api.getAuthoritativeBufferSnapshotCapabilities([id])).resolves.toEqual([
      { id, authoritative: null }
    ])
  })

  it('accepts complete host-owned absence as an exited PTY', async () => {
    callEnvironmentEnvelope.mockResolvedValue(
      success({
        terminals: [],
        truncated: false,
        hostScope: completeScope
      })
    )
    await expect(createRuntimePtyQueryApi().hasPty('remote:owner@@missing')).resolves.toBe(false)
    expect(callEnvironmentEnvelope).toHaveBeenCalledExactlyOnceWith('owner', 'terminal.list', {
      handles: ['missing'],
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  })

  it.each(['term-1', 'remote:term-1', 'remote:%ZZ@@term-1', 'remote:@@term-1'])(
    'never guesses an execution host for an unowned id (%s)',
    async (id) => {
      const api = createRuntimePtyQueryApi()
      await expect(api.hasPty(id)).resolves.toBeNull()
      await expect(api.getMainBufferSnapshot(id)).resolves.toBeNull()
      await expect(api.getAuthoritativeBufferSnapshotCapabilities([id])).resolves.toEqual([
        { id, authoritative: null }
      ])
      await expect(api.inspectProcess(id)).resolves.toMatchObject({ verdict: 'unverifiable' })
      expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
      expect(requireActiveEnvironment).not.toHaveBeenCalled()
    }
  )

  it('does not relabel an in-flight session inventory when the selected runtime changes', async () => {
    requireActiveEnvironment.mockReturnValue({ id: 'initial-environment' })
    callEnvironmentEnvelope.mockImplementation(async () => {
      requireActiveEnvironment.mockReturnValue({ id: 'replacement-environment' })
      return success({ terminals: [{ handle: 'term-1', ptyId: 'pty-1', worktreePath: '/repo' }] })
    })

    await expect(createRuntimePtyQueryApi().listSessions()).resolves.toMatchObject([
      { id: 'remote:initial-environment@@term-1', agentOwnership: 'unknown' }
    ])
    expect(callEnvironmentEnvelope).toHaveBeenCalledExactlyOnceWith(
      'initial-environment',
      'terminal.list',
      {}
    )
  })

  it('restores the original owner screen after switching to a host with the same handle', async () => {
    const snapshot = { data: 'original owner screen', cols: 100, rows: 30, seq: 7 }
    callEnvironmentEnvelope.mockResolvedValue(success({ snapshot }))

    await expect(
      createRuntimePtyQueryApi().getMainBufferSnapshot('remote:original@@term-1', {
        scrollbackRows: 50
      })
    ).resolves.toEqual(snapshot)
    expect(callEnvironmentEnvelope).toHaveBeenCalledExactlyOnceWith(
      'original',
      'terminal.bufferSnapshot',
      {
        terminal: 'term-1',
        scrollbackRows: 50
      }
    )
    expect(requireActiveEnvironment).not.toHaveBeenCalled()
  })

  it('keeps process inspection transport loss unverifiable without a request to the selected host', async () => {
    callEnvironmentEnvelope.mockResolvedValue({
      ok: false,
      error: { code: 'connection_closed', message: 'host disconnected' }
    })
    await expect(
      createRuntimePtyQueryApi().inspectProcess('remote:owner@@term-1')
    ).resolves.toMatchObject({ verdict: 'unverifiable', foregroundProcess: null })
    expect(callEnvironmentEnvelope).toHaveBeenCalledTimes(1)
    expect(requireActiveEnvironment).not.toHaveBeenCalled()
  })

  it('does not swallow unexpected process-query errors', async () => {
    callEnvironmentEnvelope.mockRejectedValue(new Error('unexpected implementation failure'))
    await expect(createRuntimePtyQueryApi().inspectProcess('remote:owner@@term-1')).rejects.toThrow(
      'unexpected implementation failure'
    )
  })

  it('does no host work for an empty capability list or an unsupported SSH session scope', async () => {
    const api = createRuntimePtyQueryApi()
    await expect(api.getAuthoritativeBufferSnapshotCapabilities([])).resolves.toEqual([])
    await expect(api.listSessions({ connectionId: 'ssh-1' })).resolves.toEqual([])
    expect(callEnvironmentEnvelope).not.toHaveBeenCalled()
    expect(requireActiveEnvironment).not.toHaveBeenCalled()
  })
})
