import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_HOST_TYPINGS_FILE, renderPluginHostTypings } from './plugin-host-typings'
import {
  authorTypingsDiagnostics,
  authorTypingsProgram
} from './plugin-author-typings.test-fixture'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

// One contract, declared once and read by the frame, the worker and the components panel.
const PROTOCOL = `
export type Todo = { id: string; title: string; done: boolean }
declare module 'orca' {
  interface PluginRequests {
    'todos.list': { input: { done?: boolean }; output: Todo[] }
    'todos.add': { input: { title: string }; output: Todo }
  }
  interface PluginPanelEvents {
    'todos.changed': { count: number }
  }
}
`

const FRAME_SCRIPT = `
import type { JsonValue } from 'orca/host'
import type { Todo } from '../protocol'

const context = await orca.host.call('workspace.readContext')
const branch: string | undefined = context?.branch
const shown: { delivered: boolean } = await window.orca.host.call('notifications.show', { title: 'Hi' })
orca.on('theme', ({ colorScheme }) => colorScheme satisfies 'light' | 'dark')
orca.on('editor.flush', async () => {})
const doc = await orca.document?.get()
if (doc?.content.kind === 'text') {
  await orca.document?.applyEdit({ baseVersion: doc.version, content: { kind: 'text', text: '' } })
}
await orca.files?.saveAs({ suggestedName: 'a.txt', data: new Uint8Array(1) })
// @ts-expect-error worker-only method
await orca.host.call('terminal.sendText', { terminalId: 't', text: 'x' })
const saved: JsonValue | null = await orca.storage.get('a')
const todos: Todo[] = await orca.plugin.request('todos.list', { done: false }, { timeoutMs: 5000 })
orca.plugin.on('todos.changed', ({ count }) => count satisfies number)
orca.on('workspace.created', ({ branch }) => branch satisfies string)
// @ts-expect-error declared requests type their input
await orca.plugin.request('todos.list', { done: 'no' })
// @ts-expect-error a declared request needs its input
await orca.plugin.request('todos.add')
const loose: JsonValue = await orca.plugin.request('undeclared.name')
// @ts-expect-error title is required
await orca.host.call('notifications.show', {})
// @ts-expect-error params are strict
await orca.host.call('workspace.readContext', { extra: true })
// @ts-expect-error unknown frame event
orca.on('worktree.created', () => {})
export { branch, shown, saved, todos, loose }
`

const WORKER_MAIN = `
import type { Activate, OrcaWorkerApi } from 'orca/worker'
import type { Todo } from './protocol'
const activate: Activate = (orca: OrcaWorkerApi) => {
  const todos: Todo[] = []
  orca.panels.handle('todos.list', async ({ done }, { panel, signal }) => {
    signal.throwIfAborted()
    orca.log(panel.id + panel.surface)
    return todos.filter((todo) => done === undefined || todo.done === done)
  })
  orca.panels.handle('todos.add', ({ title }) => {
    const todo = { id: String(todos.length), title, done: false }
    todos.push(todo)
    orca.panels.post('todos.changed', { count: todos.length })
    return todo
  })
  // @ts-expect-error a handler answers with the declared output
  orca.panels.handle('todos.add', () => ({ id: 1 }))
  // @ts-expect-error posts carry the declared payload
  orca.panels.post('todos.changed', { count: 'many' })
  orca.settings.onDidChange(({ key }) => void orca.settings.get(key))
  orca.commands.register('ping', async (_args, { signal }) => {
    const stored = await orca.host.call('storage.get', { key: 'pings' }, { signal })
    await orca.host.call('storage.set', { key: 'pings', value: [stored.value, { at: 1 }] })
    return (await orca.host.call('storage.keys')).keys.length
  })
  orca.events.on('workspace.created', (payload) => orca.log(payload.path + payload.branch))
  orca.events.on('agent.status.changed', ({ workspaceId, state, mainAgent }) => {
    const done: boolean = state === 'done' && mainAgent?.outcome === 'success'
    orca.log(String(workspaceId ?? done))
  })
  // @ts-expect-error frame-only method
  void orca.host.call('shell.openExternal', { url: 'https://example.com' })
  // @ts-expect-error unknown event
  orca.events.on('worktree.created', () => {})
  // @ts-expect-error storage values are JSON
  void orca.host.call('storage.set', { key: 'k', value: () => 1 })
}
export default activate
`

const COMPONENTS_PANEL = `
import { atom, Button, read, Stack, update, host, plugin, settings, on } from 'orca'
import type { Todo } from './protocol'
const count = atom(0)
const todos = atom<Todo[]>('todos', [], { persist: 'storage' })
void plugin.request('todos.add', { title: 'x' }).then((todo) => todo.title satisfies string)
plugin.on('todos.changed', ({ count }) => count satisfies number)
on('agent.status.changed', ({ state }) => state satisfies string)
void settings.get('apiUrl')
export default function Panel() {
  return (
    <Stack gap="md">
      <Button onPress={() => update(count, (n) => n + 1)}>{read(count) + read(todos).length}</Button>
      <Button onPress={() => void host.call('notifications.show', { title: 'x' })}>Notify</Button>
    </Stack>
  )
}
`

const PANEL_TEST = `
import { mockHost, mount, assert } from 'orca/testing'
import Panel from './panel'
import type { Todo } from './protocol'
const done: Todo = { id: '1', title: 'x', done: true }
const host = mockHost({
  requests: { 'todos.list': () => [done], 'todos.add': ({ title }) => ({ ...done, title }) },
  storage: { todos: [] },
  settings: { apiUrl: 'https://example.com' }
})
const panel = await mount(Panel, { host })
await panel.post('todos.changed', { count: 1 })
await panel.emit('agent.status.changed', { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: 1 })
// @ts-expect-error posts carry the declared payload
await panel.post('todos.changed', { count: 'one' })
assert.deepEqual(panel.persisted.storage, host.data().storage)
`

describe('author typings', () => {
  it('checks in the host typings generated from the host API table', () => {
    const checkedIn = readFileSync(path.join(REPO_ROOT, PLUGIN_HOST_TYPINGS_FILE), 'utf8')
    // Run `pnpm generate:plugin-author-typings` when this fails.
    expect(checkedIn).toBe(renderPluginHostTypings())
  })

  it('type-check a frame script, a worker main and a components panel', () => {
    const program = authorTypingsProgram({
      'protocol.ts': PROTOCOL,
      'panel/app.ts': FRAME_SCRIPT,
      'main.ts': WORKER_MAIN,
      'src/panel.tsx': COMPONENTS_PANEL,
      'src/protocol.ts': PROTOCOL,
      'src/panel.test.ts': PANEL_TEST
    })
    expect(authorTypingsDiagnostics(program)).toEqual([])
  })
})
