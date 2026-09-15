import { afterEach, describe, expect, it, vi } from 'vitest'
import { readWorktreeStructuredActivationInventory } from './worktree-agent-structured-inventory'

const worktree = 'repo::/workspace'
afterEach(() => vi.unstubAllGlobals())

function install(result: unknown, ok = true) {
  const call = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'agentSession.handoffStatus') {
      return { ok: true, result: { owner: 'native' } }
    }
    return { ok, result }
  })
  vi.stubGlobal('window', { api: { runtime: { call } } })
  return call
}

describe('structured activation inventory scope', () => {
  it('requests one workspace snapshot and retains structured handoff evidence', async () => {
    const call = install({
      worktree,
      tabs: [
        { type: 'terminal', id: 'terminal' },
        { type: 'agent-session', sessionId: 'agent' }
      ]
    })
    const result = await readWorktreeStructuredActivationInventory(worktree)
    expect(call.mock.calls[0][0]).toEqual({
      method: 'session.tabs.list',
      params: { worktree: `id:${worktree}` }
    })
    expect(call).toHaveBeenCalledTimes(2)
    expect(result && result.ownerBySessionId.get('agent')).toEqual({ owner: 'native' })
  })

  it('does not request handoffs for a workspace without structured tabs', async () => {
    const call = install({ worktree, tabs: [] })
    expect(await readWorktreeStructuredActivationInventory(worktree)).toBe(false)
    expect(call).toHaveBeenCalledOnce()
  })

  it.each([null, {}, { worktree: 'other::/workspace', tabs: [] }, { worktree }])(
    'rejects unreadable or wrong-workspace replies',
    async (result) => {
      install(result)
      await expect(readWorktreeStructuredActivationInventory(worktree)).rejects.toThrow(
        'scope unavailable'
      )
    }
  )

  it('does not interpret an RPC failure as an empty workspace', async () => {
    install(null, false)
    await expect(readWorktreeStructuredActivationInventory(worktree)).rejects.toThrow(
      'inventory unavailable'
    )
  })
})
