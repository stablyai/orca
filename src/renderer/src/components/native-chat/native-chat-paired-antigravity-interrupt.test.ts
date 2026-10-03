import { expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { createPairedAntigravityInterrupt } from './native-chat-paired-antigravity-interrupt'

function harness() {
  let row: AgentStatusEntry = {
    prompt: 'private task',
    stateStartedAt: 1,
    paneKey: 'pane',
    agentType: 'antigravity',
    state: 'working',
    updatedAt: 1,
    stateHistory: [],
    providerSession: { key: 'conversation_id', id: 'conversation' },
    observation: { authorityId: 'host', incarnation: 1, revision: 2, observedAt: 1, origin: 'hook' }
  }
  const probe = Promise.withResolvers<boolean>()
  const interrupt = vi.fn(async () => ({ accepted: true, inferred: true }))
  const helper = createPairedAntigravityInterrupt({
    environmentId: 'paired-host',
    terminal: 'terminal',
    getStatusEntry: () => row,
    supports: () => probe.promise,
    interrupt
  })
  return {
    helper,
    probe,
    interrupt,
    change: (replacement: Partial<AgentStatusEntry>) => {
      row = { ...row, ...replacement }
    }
  }
}

it('never sends a cancellation RPC or legacy input to an unsupported host', async () => {
  const h = harness()
  const operation = h.helper.cancel()
  h.probe.resolve(false)
  expect(await operation).toEqual({ accepted: false, inferred: false, reason: 'unsupported' })
  expect(h.interrupt).not.toHaveBeenCalled()
})

it('preserves transient probe errors instead of disguising them as unsupported', async () => {
  const h = harness()
  const operation = h.helper.cancel()
  h.probe.reject(new Error('disconnected'))
  await expect(operation).rejects.toThrow('disconnected')
  expect(h.interrupt).not.toHaveBeenCalled()
})

it('sends one fenced request after capability acceptance', async () => {
  const h = harness()
  const operation = h.helper.cancel()
  expect(h.helper.cancel()).toBe(operation)
  h.probe.resolve(true)
  expect(await operation).toEqual({ accepted: true, inferred: true })
  expect(h.interrupt).toHaveBeenCalledExactlyOnceWith(
    {
      terminal: 'terminal',
      providerSessionId: 'conversation',
      observation: { authorityId: 'host', incarnation: 1, revision: 2 }
    },
    expect.any(AbortSignal)
  )
})

it.each(['dispose', 'revision', 'authority', 'provider'] as const)(
  'does not write after %s during probe',
  async (change) => {
    const h = harness()
    const operation = h.helper.cancel()
    if (change === 'dispose') {
      h.helper.dispose()
    }
    if (change === 'revision') {
      h.change({
        observation: {
          authorityId: 'host',
          incarnation: 1,
          revision: 3,
          observedAt: 2,
          origin: 'hook'
        }
      })
    }
    if (change === 'authority') {
      h.change({
        observation: {
          authorityId: 'new-host',
          incarnation: 1,
          revision: 2,
          observedAt: 2,
          origin: 'hook'
        }
      })
    }
    if (change === 'provider') {
      h.change({ providerSession: { key: 'conversation_id', id: 'new-conversation' } })
    }
    h.probe.resolve(true)
    expect(await operation).toMatchObject({ accepted: false, inferred: false, reason: 'stale' })
    expect(h.interrupt).not.toHaveBeenCalled()
  }
)
