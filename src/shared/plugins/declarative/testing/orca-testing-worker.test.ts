import { afterEach, describe, expect, it } from 'vitest'
import { terminalSendHookPayloadSchema } from '../../events/plugin-hook-payloads'
import { atom, read, set } from '../runtime/declarative-atoms'
import { h } from '../runtime/declarative-elements'
import { plugin } from '../runtime/orca-module'
import { mockHost, mount, mountWorker, type TestPanel } from './orca-testing'

type Orca = {
  log(message: string): void
  host: { call(method: string, params?: unknown): Promise<unknown> }
  events: { on(event: string, handler: (payload: unknown) => unknown): unknown }
  commands: { register(id: string, handler: (args: unknown) => unknown): unknown }
  panels: {
    handle(
      name: string,
      handler: (input: unknown, context: { panel: { contributionId: string } }) => unknown
    ): unknown
    post(event: string, payload?: unknown): void
  }
  storage: { set(key: string, value: unknown): Promise<void> }
}

type HookedOrca = Orca & {
  hooks: {
    on(hook: string, handler: (event: unknown, next: (e: unknown) => unknown) => unknown): unknown
  }
}

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
})

describe('mountWorker', () => {
  it('fires hooks as Orca would and returns what the chain decided', async () => {
    const mounted = await mountWorker(
      {
        default(orca: HookedOrca) {
          orca.hooks.on('terminal.send', (event, next) => {
            const { text } = terminalSendHookPayloadSchema.parse(event)
            if (text.includes('rm -rf')) {
              return { deny: 'blocked' }
            }
            if (text === 'boom') {
              throw new Error('hook failed')
            }
            return next({ ...terminalSendHookPayloadSchema.parse(event), text: text.trim() })
          })
        }
      },
      { events: [], commands: [], hooks: ['terminal.send'] }
    )
    const send = (text: string) => ({ terminalId: 't', text, enter: true, inputKind: 'driving' })
    await expect(mounted.hooks.fire('terminal.send', send(' ls '))).resolves.toEqual({
      kind: 'continue',
      event: send('ls')
    })
    await expect(mounted.hooks.fire('terminal.send', send('rm -rf /'))).resolves.toEqual({
      kind: 'deny',
      reason: 'blocked'
    })
    await expect(mounted.hooks.fire('terminal.send', send('boom'))).resolves.toEqual({
      kind: 'continue',
      event: send('boom')
    })
    expect(mounted.logs.at(-1)).toMatch(/hook terminal\.send skipped after \d+ms: hook failed/)
    await expect(mounted.hooks.fire('terminal.send', { text: 1 })).rejects.toThrow(
      /not one Orca sends/
    )
    await expect(mounted.hooks.fire('workspace.create.after', {})).rejects.toThrow(
      /not in contributes.hooks/
    )
  })
})

describe('a panel and its worker on one host', () => {
  it("routes the panel's plugin.request to the mounted worker, unless `requests` stubs it", async () => {
    const host = mockHost({ capabilities: [], requests: { stubbed: 'from the stub' } })
    const worker = await mountWorker(
      {
        default: (orca: Orca) => {
          orca.panels.handle('stats', (input) => ({ asked: input }))
          orca.panels.handle('stubbed', () => 'from the worker')
        }
      },
      { host, events: [], commands: [] }
    )
    const answers = atom<unknown[]>([])
    panel = await mount(
      {
        setup: () => {
          void Promise.all([
            plugin.request('stats', { n: 1 }),
            plugin.request('stubbed'),
            plugin.request('missing').catch((error: { code?: string }) => error.code)
          ]).then((values) => set(answers, values))
        },
        default: () => h('Text', null, JSON.stringify(read(answers)))
      },
      { host }
    )
    expect(panel.find({ role: 'text' })?.text).toBe(
      JSON.stringify([{ asked: { n: 1 } }, 'from the stub', 'unknown_method'])
    )
    await worker.deactivate()
  })
})
