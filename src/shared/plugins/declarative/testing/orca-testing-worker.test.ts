import { afterEach, describe, expect, it } from 'vitest'
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

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
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
