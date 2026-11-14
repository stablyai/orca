import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginHookParticipantGoneError,
  runPluginHookChain,
  type PluginHookChainInput
} from './plugin-hook-chain'
import { runPluginWorkerHookHandlers, type PluginHookHandler } from './plugin-worker-hooks'
import { terminalSendHookPayloadSchema } from '../events/plugin-hook-payloads'

const send = { terminalId: 'term_1', text: 'ls', enter: true, inputKind: 'driving' }
const read = (event: unknown) => terminalSendHookPayloadSchema.parse(event)

/** Each plugin is a list of worker handlers, run as its worker would run them. */
function chain(
  plugins: Record<string, PluginHookHandler[]>,
  overrides: Partial<PluginHookChainInput> = {}
) {
  const outcome = runPluginHookChain({
    event: 'terminal.send',
    payload: send,
    participants: Object.keys(plugins),
    invoke: (pluginKey, payload) => runPluginWorkerHookHandlers(plugins[pluginKey] ?? [], payload),
    log: () => undefined,
    now: () => 0,
    ...overrides
  })
  return { outcome }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runPluginHookChain', () => {
  it('carries a changed event to the next plugin, in order', async () => {
    const seen: string[] = []
    const { outcome } = chain({
      'a.one': [(event, next) => next({ ...read(event), text: 'ls -la' })],
      'a.two': [
        (event, next) => {
          seen.push(read(event).text)
          return next({ ...read(event), enter: false })
        }
      ]
    })
    await expect(outcome).resolves.toEqual({
      kind: 'continue',
      payload: { ...send, text: 'ls -la', enter: false }
    })
    expect(seen).toEqual(['ls -la'])
  })

  it('stops at a deny, so later plugins never run', async () => {
    const later = vi.fn()
    const { outcome } = chain({
      'a.one': [() => ({ deny: 'blocked' })],
      'a.two': [later]
    })
    await expect(outcome).resolves.toEqual({ kind: 'deny', pluginKey: 'a.one', reason: 'blocked' })
    expect(later).not.toHaveBeenCalled()
  })

  it('continues to the next plugin after a handler throws', async () => {
    const { outcome } = chain({
      'a.one': [
        () => {
          throw new Error('boom')
        }
      ],
      'a.two': [(event, next) => next({ ...read(event), text: 'pwd' })]
    })
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: { ...send, text: 'pwd' } })
  })

  it('carries on past a plugin that misses its deadline', async () => {
    vi.useFakeTimers()
    const { outcome } = chain(
      { 'a.slow': [], 'a.next': [] },
      {
        invoke: (pluginKey, payload) =>
          pluginKey === 'a.slow'
            ? new Promise(() => undefined)
            : runPluginWorkerHookHandlers([() => ({ deny: 'second' })], payload),
        deadlineMs: 2_000
      }
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(outcome).resolves.toEqual({ kind: 'deny', pluginKey: 'a.next', reason: 'second' })
  })

  it('refuses when a fail-closed plugin throws or answers nonsense', async () => {
    const failsClosed = () => true
    const thrown = chain(
      {
        'a.guard': [
          () => {
            throw new Error('status bar down')
          }
        ]
      },
      { failsClosed }
    )
    await expect(thrown.outcome).resolves.toEqual({
      kind: 'deny',
      pluginKey: 'a.guard',
      reason: 'a.guard failed and denies on error: status bar down'
    })
    const nonsense = chain(
      {},
      { participants: ['a.guard'], invoke: async () => 'nope', failsClosed }
    )
    await expect(nonsense.outcome).resolves.toMatchObject({ kind: 'deny', pluginKey: 'a.guard' })
  })

  it('passes a fail-closed plugin that is gone, and observe-only hooks', async () => {
    const gone = chain(
      {},
      {
        participants: ['a.guard'],
        invoke: async () => {
          throw new PluginHookParticipantGoneError('the plugin is no longer enabled')
        },
        failsClosed: () => true
      }
    )
    await expect(gone.outcome).resolves.toEqual({ kind: 'continue', payload: send })
    const created = { workspaceId: 'w', kind: 'folder', path: '/w', branch: '' }
    const observe = chain(
      {},
      {
        event: 'workspace.create.after',
        payload: created,
        participants: ['a.guard'],
        invoke: async () => {
          throw new Error('boom')
        },
        failsClosed: () => true
      }
    )
    await expect(observe.outcome).resolves.toEqual({ kind: 'continue', payload: created })
  })
})
