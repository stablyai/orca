// @vitest-environment happy-dom
// Move all sends one row at a time, each with only its own confirmed agents, and stops at a failure;
// Cancel sends nothing. Synthetic servers only.
import { act } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredMcpServer } from '../../../../../shared/mcp-servers/mcp-servers'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import { McpServersPane } from './McpServersPane'

type Pending = { method: string; params: Record<string, unknown>; settle: (ok: boolean) => void }
const rpc = vi.hoisted(() => ({ calls: [] as Pending[] }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (_target: unknown, method: string, params: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      rpc.calls.push({
        method,
        params,
        settle: (ok) =>
          ok
            ? resolve({ server: { id: `host-${String(params.key)}`, name: String(params.key) } })
            : reject(new Error('synthetic move failure'))
      })
    })
}))

const discovered = vi.hoisted(() => ({ servers: [] as DiscoveredMcpServer[] }))
vi.mock('./use-mcp-servers', () => ({
  useStableMcpTarget: (target: unknown) => target,
  useMcpServers: () => ({
    list: { servers: [], agentFiles: { grok: false, cursor: true, droid: false } },
    discovered: discovered.servers,
    problems: {},
    error: null,
    reload: () => {}
  })
}))
vi.mock('./mcp-server-agents', () => ({ useMcpServerAgents: () => [] }))
vi.mock('./use-mcp-host-workspaces', () => ({ useMcpHostWorkspaces: () => [] }))
vi.mock('./McpServersAddDialog', () => ({ McpServersAddDialog: () => null }))
vi.mock('./McpServerSignInDialog', () => ({ McpServerSignInDialog: () => null }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const server = (key: string, removesFrom: string[]): DiscoveredMcpServer => ({
  key,
  name: key,
  detail: `https://${key}.example.test/mcp`,
  transport: 'http',
  agents: removesFrom,
  removesFrom,
  files: [],
  projectNames: [],
  movable: true
})

const ALL_LINE =
  "Orca moves servers one at a time, stopping if one fails. For each server it reaches, it uses a new or existing entry on this host's MCP server list and tries to remove eligible copies from the settings for Codex and Cursor. Before removing entries from a settings file, Orca backs up that file."

const moves = () => rpc.calls.filter((call) => call.method === 'mcpServers.move')
const mutations = () =>
  rpc.calls.filter((call) => ['mcpServers.move', 'mcpServers.copy'].includes(call.method))
const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

function renderPane() {
  render(
    <ConfirmationDialogProvider>
      <McpServersPane
        target={{ kind: 'local' }}
        hostName="Synthetic host"
        onOpenServer={() => {}}
      />
    </ConfirmationDialogProvider>
  )
  return userEvent.setup()
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  rpc.calls = []
  discovered.servers = [
    server('alpha', ['codex']),
    server('beta', ['codex', 'cursor']),
    server('gamma', ['cursor'])
  ]
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Move all to Orca', () => {
  it('names the union, then sends each row alone with its own agents and stops at a failure', async () => {
    const user = renderPane()
    await act(async () => user.click(screen.getByRole('button', { name: 'Move all to Orca' })))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(ALL_LINE)).toBeTruthy()

    await act(async () => user.click(within(dialog).getByRole('button', { name: 'Move' })))
    await flush()
    expect(moves().map((call) => call.params)).toEqual([{ key: 'alpha', agents: ['codex'] }])

    await act(async () => moves()[0]!.settle(true))
    await flush()
    expect(moves().map((call) => call.params)).toEqual([
      { key: 'alpha', agents: ['codex'] },
      { key: 'beta', agents: ['codex', 'cursor'] }
    ])

    await act(async () => moves()[1]!.settle(false))
    await flush()
    // gamma is never requested.
    expect(moves()).toHaveLength(2)
  })

  it('Cancel sends no Move, for the batch and for one server', async () => {
    const user = renderPane()
    await act(async () => user.click(screen.getByRole('button', { name: 'Move all to Orca' })))
    await act(async () =>
      user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    )
    await flush()

    await act(async () => user.click(screen.getAllByRole('button', { name: 'Move to Orca' })[0]!))
    const dialog = await screen.findByRole('dialog')
    expect(
      within(dialog).getByText(
        "Orca uses a new or existing entry on this host's MCP server list. It tries to remove eligible copies from the settings for Codex. Before removing entries from a settings file, Orca backs up that file."
      )
    ).toBeTruthy()
    await act(async () => user.click(within(dialog).getByRole('button', { name: 'Cancel' })))
    await flush()

    expect(mutations()).toEqual([])
  })
})
