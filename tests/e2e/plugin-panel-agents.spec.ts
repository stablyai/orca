/**
 * Invariant: a panel can show the workspace's agents without polling. `agents.list` names each
 * agent's terminal, `agent.status.changed` reaches the panel with the same `terminalId`, and
 * `workspace.changed` arrives on subscribe (the current context) and again when a terminal opens.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import {
  ISOLATED_FRAMES_E2E,
  pluginGuest,
  readInGuest,
  waitForGuestReady
} from './helpers/plugin-frame-guest'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test.use(ISOLATED_FRAMES_E2E)

const PANEL = `<!doctype html><html><body><script>
window.__seen = { agents: [], workspace: [] }
orca.on('agent.status.changed', (payload) => window.__seen.agents.push(payload))
orca.on('workspace.changed', (payload) => window.__seen.workspace.push(payload))
window.__ask = (method) => orca.host.call(method).then((value) => { window.__answer = value })
</script></body></html>`

test('a panel lists agents and hears their status and workspace changes', async ({
  orcaPage,
  electronApp
}) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-panel-agents-'))
  const pluginRoot = join(tempRoot, 'agent-board')
  try {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await mkdir(pluginRoot, { recursive: true })
    await writeFile(join(pluginRoot, 'panel.html'), PANEL)
    await writeFile(
      join(pluginRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'agent-board',
        name: 'Agent Board',
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        pluginApi: 1,
        contributes: { panels: [{ id: 'board', title: 'Agent Board', entry: 'panel.html' }] },
        capabilities: [{ kind: 'agent:read' }, { kind: 'workspace:read' }]
      })
    )
    await enableDevPlugins(orcaPage, [pluginRoot])
    await orcaPage.evaluate(async () => {
      const store = window.__store?.getState()
      if (store && !store.rightSidebarOpen) {
        store.toggleRightSidebar()
      }
      await window.api.plugins.refresh()
    })
    await orcaPage.getByRole('button', { name: 'Agent Board' }).click({ timeout: 15_000 })
    const guest = pluginGuest(orcaPage, 'Agent Board')
    await waitForGuestReady(guest)
    const ask = async <T>(method: string): Promise<T> => {
      await readInGuest(guest, `window.__ask(${JSON.stringify(method)})`)
      let answer: T | null = null
      await expect
        .poll(async () => (answer = await readInGuest<T>(guest, 'window.__answer ?? null')))
        .not.toBeNull()
      await readInGuest(guest, 'window.__answer = null')
      return answer!
    }
    const context = await ask<{ terminals: { id: string; title?: string }[] }>(
      'workspace.readContext'
    )
    expect(context.terminals.length).toBeGreaterThan(0)
    // Replay on subscribe: the panel heard the focused workspace without any change happening.
    await expect
      .poll(async () => {
        const changes =
          (await readInGuest<{ context: { displayName: string } | null }[]>(
            guest,
            'window.__seen.workspace'
          )) ?? []
        return changes[0]?.context?.displayName ?? null
      })
      .not.toBeNull()

    const endpoint = await readHookEndpoint(electronApp)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    await emitCodexHookStatus(endpoint, { ...descriptor, state: 'working', prompt: 'Board' })
    const terminalIds = context.terminals.map(({ id }) => id)
    type AgentEvent = { paneKey: string; state: string; terminalId?: string }
    const matched = async (): Promise<AgentEvent | null> => {
      const seen = (await readInGuest<AgentEvent[]>(guest, 'window.__seen.agents')) ?? []
      return seen.find((event) => event.paneKey === descriptor.paneKey) ?? null
    }
    await expect.poll(matched, { timeout: 15_000 }).not.toBeNull()
    const event = await matched()
    expect(event?.state).toBe('working')
    expect(terminalIds).toContain(event?.terminalId)
    const { agents } = await ask<{ agents: { terminalId: string | null; state: string }[] }>(
      'agents.list'
    )
    expect(agents.find((agent) => agent.terminalId === event?.terminalId)?.state).toBe('working')

    // A terminal opening in the focused workspace reaches the panel without a poll.
    await orcaPage.evaluate((id) => {
      window.__store?.getState().createTab(id, undefined, undefined, { activate: false })
    }, worktreeId)
    await expect
      .poll(
        async () => {
          const changes =
            (await readInGuest<{ context: { terminals: unknown[] } | null }[]>(
              guest,
              'window.__seen.workspace'
            )) ?? []
          return changes.some(
            (change) => (change.context?.terminals.length ?? 0) > terminalIds.length
          )
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
