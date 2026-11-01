import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_HOST_TYPINGS_FILE, renderPluginHostTypings } from './plugin-host-typings'
import {
  authorTypingsDiagnostics,
  authorTypingsProgram
} from './plugin-author-typings.test-fixture'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

const FRAME_SCRIPT = `
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
await orca.host.call('storage.get', { key: 'a' })
// @ts-expect-error title is required
await orca.host.call('notifications.show', {})
// @ts-expect-error params are strict
await orca.host.call('workspace.readContext', { extra: true })
// @ts-expect-error unknown frame event
orca.on('workspace.created', () => {})
export { branch, shown }
`

const WORKER_MAIN = `
import type { Activate, OrcaWorkerApi } from 'orca/worker'
const activate: Activate = (orca: OrcaWorkerApi) => {
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
import { atom, Button, read, Stack, update, host } from 'orca'
const count = atom(0)
export default function Panel() {
  return (
    <Stack gap="md">
      <Button onPress={() => update(count, (n) => n + 1)}>{read(count)}</Button>
      <Button onPress={() => void host.call('notifications.show', { title: 'x' })}>Notify</Button>
    </Stack>
  )
}
`

describe('author typings', () => {
  it('checks in the host typings generated from the host API table', () => {
    const checkedIn = readFileSync(path.join(REPO_ROOT, PLUGIN_HOST_TYPINGS_FILE), 'utf8')
    // Run `pnpm generate:plugin-author-typings` when this fails.
    expect(checkedIn).toBe(renderPluginHostTypings())
  })

  it('type-check a frame script, a worker main and a components panel', () => {
    const program = authorTypingsProgram({
      'panel/app.ts': FRAME_SCRIPT,
      'main.ts': WORKER_MAIN,
      'src/panel.tsx': COMPONENTS_PANEL
    })
    expect(authorTypingsDiagnostics(program)).toEqual([])
  })
})
