import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const WORKER = String.raw`
export default function activate(orca) {
  async function workspaces() {
    const result = await orca.host.call('workspace.list')
    if (result.truncated) throw new Error('Workspace inventory is incomplete')
    return result.workspaces
  }
  async function target(id) {
    const matches = (await workspaces()).filter(row => row.id === id)
    if (matches.length !== 1) throw new Error('Choose a unique workspace')
    return matches[0]
  }
  orca.panels.handle('acme.workspaces', workspaces)
  orca.panels.handle('acme.settings', () => orca.host.call('settings.open'))
  orca.panels.handle('acme.agents', async ({ workspaceId }) => {
    await target(workspaceId)
    return orca.host.call('agents.available', { workspaceId })
  })
  orca.panels.handle('acme.create', async ({ workspaceId }) => {
    const source = await target(workspaceId)
    if (!source.projectId || source.kind !== 'worktree') throw new Error('Choose a Git project')
    const created = await orca.host.call('workspace.create', {
      projectId: source.projectId, hostId: source.hostId ?? undefined,
      name: 'acme-plugin-handoff', baseBranch: source.branch ?? undefined, setup: 'skip'
    })
    return target(created.workspaceId)
  })
  orca.panels.handle('acme.open', async ({ workspaceId }) => {
    await target(workspaceId)
    return orca.host.call('workspace.open', { workspaceId })
  })
  orca.panels.handle('acme.launch', async ({ workspaceId, agent }) => {
    await target(workspaceId)
    const available = await orca.host.call('agents.available', { workspaceId })
    if (!available.agents.some(row => row.id === agent)) throw new Error('Choose an installed Agent')
    return orca.host.call('agent.launch', {
      workspaceId, agent, prompt: 'ACME_TASK_42_IMPLEMENTATION_HANDOFF'
    })
  })
  orca.panels.handle('acme.output', ({ terminalId }) => orca.host.call('terminal.read', { terminalId }))
  orca.panels.handle('acme.reveal', ({ terminalId }) => orca.host.call('terminal.focus', { terminalId }))
}
`

const PANEL = String.raw`
import { atom, Button, Heading, plugin, read, Select, set, Stack, Text } from 'orca'
const state = atom({ rows: [], target: null, agents: [], agent: '', terminalId: '', output: '', message: '', busy: false })
function patch(value) { set(state, { ...read(state), ...value }) }
async function act(effect) {
  patch({ busy: true, message: '' })
  try { await effect() } catch (error) { patch({ message: String(error) }) }
  finally { patch({ busy: false }) }
}
async function choose(row) {
  patch({ target: row, agents: [], agent: '', terminalId: '', output: '' })
  const result = await plugin.request('acme.agents', { workspaceId: row.id })
  patch({ agents: result.agents })
}
export function setup() {
  void act(async () => patch({ rows: await plugin.request('acme.workspaces') }))
}
export default function Panel() {
  const value = read(state)
  const selected = value.target
  return <Stack gap="sm">
    <Heading>Acme task 42</Heading>
    <Button variant="outline" onPress={() => act(() => plugin.request('acme.settings'))}>Connection settings</Button>
    <Select label="Code workspace" placeholder="Choose code workspace" value={selected?.id ?? ''}
      disabled={value.busy} options={value.rows.map(row => ({ value: row.id, label: row.path }))}
      onChange={id => act(() => choose(value.rows.find(row => row.id === id)))} />
    {selected ? <Stack gap="xs">
      <Text>{'Target ID: ' + selected.id}</Text>
      <Text>{'Target path: ' + selected.path}</Text>
      <Text>{'Project: ' + selected.project + ' · branch: ' + selected.branch + ' · host: ' + selected.hostId}</Text>
      <Button disabled={value.busy} onPress={() => act(async () => {
        const row = await plugin.request('acme.create', { workspaceId: selected.id })
        patch({ rows: await plugin.request('acme.workspaces') })
        await choose(row)
      })}>Create code workspace</Button>
      <Button variant="outline" disabled={value.busy} onPress={() => act(() => plugin.request('acme.open', { workspaceId: selected.id }))}>Open code workspace</Button>
      <Select label="Installed Agent" placeholder="Choose installed Agent" value={value.agent} disabled={value.busy}
        options={value.agents.map(row => ({ value: row.id, label: row.label }))} onChange={agent => patch({ agent })} />
      <Button disabled={value.busy || !value.agent || Boolean(value.terminalId)} onPress={() => act(async () => {
        const result = await plugin.request('acme.launch', { workspaceId: selected.id, agent: value.agent })
        patch({ terminalId: result.terminalId })
      })}>Start selected Agent</Button>
    </Stack> : null}
    {value.terminalId ? <Stack gap="xs">
      <Text>{'Launched terminal: ' + value.terminalId}</Text>
      <Button disabled={value.busy} onPress={() => act(() => plugin.request('acme.reveal', { terminalId: value.terminalId }))}>Open Agent terminal</Button>
      <Button variant="outline" disabled={value.busy} onPress={() => act(async () => {
        const result = await plugin.request('acme.output', { terminalId: value.terminalId })
        patch({ output: result.lines.join('\n') })
      })}>Read delivery</Button>
      <Text>{value.output}</Text>
    </Stack> : null}
    {value.message ? <Text tone="danger">{value.message}</Text> : null}
  </Stack>
}
`

export async function writeIntegrationHandoffFixture(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(join(root, 'worker.ts'), WORKER),
    writeFile(join(root, 'panel.tsx'), PANEL),
    writeFile(
      join(root, 'settings.tsx'),
      'import { Heading, Stack, Text } from \'orca\'; export default function Settings() { return <Stack gap="sm"><Heading>AcmeTasks connection</Heading><Text>Local synthetic provider</Text></Stack> }'
    ),
    writeFile(
      join(root, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'trusted-worker',
        id: 'acme-tasks',
        name: 'AcmeTasks',
        version: '1.0.0',
        engines: { orca: '>=1.4.258' },
        pluginApi: 1,
        main: 'worker.ts',
        contributes: {
          panels: [
            {
              id: 'tasks',
              title: 'AcmeTasks',
              icon: 'layers',
              entry: 'panel.tsx',
              ui: 'components'
            },
            {
              id: 'connection',
              title: 'AcmeTasks connection',
              icon: 'plug',
              entry: 'settings.tsx',
              ui: 'components',
              location: 'settings'
            }
          ]
        },
        capabilities: [
          'workspace:read',
          'workspace:write',
          'workspace:create',
          'agent:read',
          'agent:launch',
          'terminal:read',
          'settings:own'
        ].map((kind) => ({ kind }))
      })
    )
  ])
}
