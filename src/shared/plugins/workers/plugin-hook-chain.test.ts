import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPluginHookChain, type PluginHookChainInput } from './plugin-hook-chain'
import { runPluginWorkerHookHandlers, type PluginHookHandler } from './plugin-worker-hooks'
import { terminalSendHookPayloadSchema } from '../events/plugin-hook-payloads'

const send = { terminalId: 'term_1', text: 'ls', enter: true, inputKind: 'driving' }
const read = (event: unknown) => terminalSendHookPayloadSchema.parse(event)

/** Each plugin is a list of worker handlers, run as its worker would run them. */
function chain(
  plugins: Record<string, PluginHookHandler[]>,
  overrides: Partial<PluginHookChainInput> = {}
) {
  const logs: string[] = []
  const outcome = runPluginHookChain({
    event: 'terminal.send',
    payload: send,
    participants: Object.keys(plugins),
    invoke: (pluginKey, payload) => runPluginWorkerHookHandlers(plugins[pluginKey] ?? [], payload),
    log: (pluginKey, line) => void logs.push(`${pluginKey}: ${line}`),
    now: () => 0,
    ...overrides
  })
  return { outcome, logs }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runPluginHookChain', () => {
  it('passes the event through unchanged when handlers return nothing', async () => {
    const { outcome, logs } = chain({ 'a.one': [() => undefined], 'a.two': [] })
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: send })
    expect(logs).toEqual([])
  })

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

  it('keeps fields the hook does not let plugins change', async () => {
    const { outcome } = chain({
      'a.one': [(event, next) => next({ ...read(event), terminalId: 'term_other' })]
    })
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: send })
  })

  it('ignores an invalid change and logs it', async () => {
    const { outcome, logs } = chain({
      'a.one': [(event, next) => next({ ...read(event), enter: 'yes' })]
    })
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: send })
    expect(logs[0]).toMatch(/^a\.one: hook terminal\.send: change ignored/)
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

  it('treats an unreadable result as passing', async () => {
    const { outcome, logs } = chain({ 'a.one': [() => ({ deny: 7 })] })
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: send })
    expect(logs[0]).toMatch(/result ignored/)
  })

  it('treats a throw as passing and logs plugin, event and duration', async () => {
    const { outcome, logs } = chain(
      {
        'a.one': [
          () => {
            throw new Error('boom')
          }
        ],
        'a.two': [(event, next) => next({ ...read(event), text: 'pwd' })]
      },
      { now: vi.fn().mockReturnValueOnce(10).mockReturnValue(42) }
    )
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: { ...send, text: 'pwd' } })
    expect(logs).toEqual(['a.one: hook terminal.send skipped after 32ms: boom'])
  })

  it('carries on past a plugin that misses its deadline', async () => {
    vi.useFakeTimers()
    const { outcome, logs } = chain(
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
    expect(logs).toEqual(['a.slow: hook terminal.send skipped after 0ms: timed out after 2000ms'])
  })

  it('ignores results of observe-only hooks', async () => {
    const created = { workspaceId: 'w', kind: 'folder', path: '/tmp/w', branch: '' }
    const { outcome } = chain(
      { 'a.one': [() => ({ deny: 'no' })] },
      { event: 'workspace.create.after', payload: created }
    )
    await expect(outcome).resolves.toEqual({ kind: 'continue', payload: created })
  })

  it('runs one worker’s handlers in registration order', async () => {
    const decision = await runPluginWorkerHookHandlers(
      [
        (event, next) => next({ ...read(event), text: 'a' }),
        (event, next) => next({ ...read(event), text: `${read(event).text}b` })
      ],
      send
    )
    expect(decision).toEqual({ decision: 'continue', payload: { ...send, text: 'ab' } })
  })
})
