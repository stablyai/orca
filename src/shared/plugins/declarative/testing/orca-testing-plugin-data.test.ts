import { afterEach, describe, expect, it } from 'vitest'
import { atom, read, set } from '../runtime/declarative-atoms'
import { h } from '../runtime/declarative-elements'
import { plugin, settings, storage } from '../runtime/orca-module'
import { hostError, mockHost, mount, type TestPanel } from './orca-testing'

let panel: TestPanel | null = null
afterEach(async () => {
  await panel?.unmount()
  panel = null
})

const todos = atom<string[]>('testing.todos', [], { persist: 'storage' })
const message = atom('')

const Todos = () =>
  h(
    'Stack',
    null,
    h('Text', null, `${read(todos).length} todos ${read(message)}`),
    h(
      'Button',
      {
        onPress: async () => {
          const answer = await plugin.request('todos.suggest', { taken: read(todos) })
          set(todos, [...read(todos), String(answer)])
        }
      },
      'Suggest'
    ),
    h(
      'Button',
      {
        onPress: () =>
          plugin.request('todos.fail').catch((error: { code: string }) => set(message, error.code))
      },
      'Fail'
    )
  )

describe('orca/testing and the plugin bridge', () => {
  it("answers plugin.request from `requests`, and keeps storage atoms in the host's storage", async () => {
    const host = mockHost({
      capabilities: ['storage:own'],
      storage: { 'testing.todos': ['seeded'] },
      requests: {
        'todos.suggest': (input: unknown) => `idea ${JSON.stringify(input)}`,
        'todos.fail': () => {
          throw hostError('conflict', 'taken')
        }
      }
    })
    panel = await mount(Todos, { host })
    expect(panel.find({ role: 'text' })?.text).toBe('1 todos')
    await panel.press({ text: 'Suggest' })
    expect(host.callsOf('plugin.request')).toEqual([
      { name: 'todos.suggest', input: { taken: ['seeded'] } }
    ])
    expect(panel.persisted.storage['testing.todos']).toEqual([
      'seeded',
      'idea {"taken":["seeded"]}'
    ])
    await panel.press({ text: 'Fail' })
    expect(panel.find({ role: 'text' })?.text).toBe('2 todos conflict')
  })

  it('hears worker posts, and storage and settings changes', async () => {
    const heard: unknown[] = []
    const host = mockHost({
      capabilities: ['storage:own', 'settings:own'],
      settings: { theme: 'dark' }
    })
    panel = await mount(
      {
        setup: (ctx) => {
          ctx.subscriptions.push(
            plugin.on('todos.changed', (payload) => heard.push(payload)),
            storage.onDidChange(({ key }) => heard.push(`storage:${key}`))
          )
        },
        default: () => h('Text', null, 'x')
      },
      { host }
    )
    await panel.post('todos.changed', { count: 2 })
    await storage.set('filter', 'open')
    await panel.settled()
    expect(heard).toEqual([{ count: 2 }, 'storage:filter'])
    await expect(settings.get('theme')).resolves.toBe('dark')
    expect(host.data().storage).toEqual({ filter: 'open' })
  })

  it('refuses storage without the capability, as Orca would', async () => {
    panel = await mount(() => h('Text', null, 'x'), { host: mockHost({ capabilities: [] }) })
    await expect(storage.get('k')).rejects.toMatchObject({ code: 'capability_denied' })
  })
})
