import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequestedWorktree } from './create-requested-worktree'
import { makeRequest } from './worktree-creation-request.test-fixture'

const { createWorktree } = vi.hoisted(() => ({ createWorktree: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ createWorktree }) }
}))
vi.mock('@/lib/worktree-draft-startup-view-mode', () => ({
  resolveBackendDraftStartup: (request: { startup?: unknown }) => request.startup
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { location: { pathname: '/' }, api: { worktrees: {} } })
})

describe('durable composer creation launch boundary', () => {
  it.each(['command', 'draft'] as const)(
    'withholds agent %s execution until Create while retaining workspace metadata',
    async (delivery) => {
      const request = makeRequest({
        agent: 'codex',
        startup: delivery === 'command' ? { command: 'codex', launchAgent: 'codex' } : undefined,
        launchDraftPrompt: 'Investigate this task',
        startupPlan: {
          agent: 'codex',
          launchCommand: 'codex',
          expectedProcess: 'codex',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      })
      const snapshot = structuredClone(request)
      await createRequestedWorktree('reservation', request, true)
      const args = createWorktree.mock.calls[0]
      expect(args[10]).toBe('codex')
      expect(args[16]).toBeUndefined()
      expect(args[25]).not.toHaveProperty('startupDraft')
      expect(request).toEqual(snapshot)
    }
  )

  it('prepares the original agent command behind an owner capability without mutating the request', async () => {
    const supportsDeferredStartup = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('window', {
      location: { pathname: '/' },
      api: { worktrees: { supportsDeferredStartup } }
    })
    const request = makeRequest({
      agent: 'codex',
      startupPlan: {
        agent: 'codex',
        launchCommand: 'codex --model fixture',
        expectedProcess: 'codex',
        followupPrompt: null,
        env: { PROJECT: 'fixture' },
        launchConfig: { agentArgs: '--model fixture', agentEnv: { PROJECT: 'fixture' } }
      }
    })
    const snapshot = structuredClone(request)

    await createRequestedWorktree('reservation', request, true)

    expect(supportsDeferredStartup).toHaveBeenCalledWith('repo-1')
    expect(createWorktree.mock.calls[0][16]).toMatchObject({
      command: 'codex --model fixture',
      launchAgent: 'codex',
      env: { PROJECT: 'fixture' },
      launchToken: 'reservation',
      deferredStartupOperationId: 'reservation',
      activate: false
    })
    expect(request).toEqual(snapshot)
  })

  it.each(['unsupported', 'disconnected'])(
    'keeps checkout-only agent preparation when the owner is %s',
    async (owner) => {
      const supportsDeferredStartup = vi.fn()
      if (owner === 'unsupported') {
        supportsDeferredStartup.mockResolvedValue(false)
      } else {
        supportsDeferredStartup.mockRejectedValue(new Error('connection lost'))
      }
      vi.stubGlobal('window', {
        location: { pathname: '/' },
        api: { worktrees: { supportsDeferredStartup } }
      })
      await createRequestedWorktree(
        'reservation',
        makeRequest({
          agent: 'codex',
          startup: { command: 'codex', launchAgent: 'codex' },
          launchDraftPrompt: 'Unsent task',
          startupPlan: {
            agent: 'codex',
            launchCommand: 'codex',
            expectedProcess: 'codex',
            followupPrompt: null,
            launchConfig: { agentArgs: '', agentEnv: {} }
          }
        }),
        true
      )
      expect(createWorktree.mock.calls[0][16]).toBeUndefined()
      expect(createWorktree.mock.calls[0][25]).not.toHaveProperty('startupDraft')
    }
  )

  it('never asks a paired web client to prepare a local agent shell', async () => {
    const supportsDeferredStartup = vi.fn(async () => true)
    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      location: { pathname: '/' },
      api: { worktrees: { supportsDeferredStartup } }
    })
    await createRequestedWorktree(
      'reservation',
      makeRequest({
        agent: 'codex',
        startupPlan: {
          agent: 'codex',
          launchCommand: 'codex',
          expectedProcess: 'codex',
          followupPrompt: null,
          launchConfig: { agentArgs: '', agentEnv: {} }
        }
      }),
      true
    )
    expect(supportsDeferredStartup).not.toHaveBeenCalled()
    expect(createWorktree.mock.calls[0][16]).toBeUndefined()
  })

  it('launches the agent with renderer-owned completion focus', async () => {
    const startup = { command: 'codex', launchAgent: 'codex' as const }
    await createRequestedWorktree('submit', makeRequest({ agent: 'codex', startup }))
    expect(createWorktree.mock.calls[0][16]).toEqual(startup)
    expect(createWorktree.mock.calls[0][25]).toMatchObject({ callerOwnsCompletion: true })
  })

  it('preserves ordinary host-owned draft launch', async () => {
    await createRequestedWorktree(
      'submit',
      makeRequest({ agent: 'codex', launchDraftPrompt: 'Unsent task' })
    )
    expect(createWorktree.mock.calls[0][25]).toMatchObject({ startupDraft: 'Unsent task' })
  })

  it('continues warming blank shells without selecting them', async () => {
    await createRequestedWorktree(
      'reservation',
      makeRequest({ startup: { command: '', env: { PROJECT: 'fixture' } } }),
      true
    )
    expect(createWorktree.mock.calls[0][16]).toEqual({
      command: '',
      env: { PROJECT: 'fixture' },
      activate: false
    })
  })
})
