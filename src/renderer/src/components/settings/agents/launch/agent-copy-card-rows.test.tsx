import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { agentCopyCardRows, type AgentCardScope } from './agent-copy-card-rows'
import type { useAgentCopySettings } from './use-agent-copy-settings'

const claude: AgentCatalogEntry = { id: 'claude', label: 'Claude', cmd: 'claude' }
const copy = {
  id: 'claude.haiku',
  name: 'Claude Haiku',
  agent: 'claude' as const,
  command: '/opt/haiku/claude',
  chat: false
}

function setup(local = true) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial settings object; the builder reads only the copy and command slots.
  const settings = {
    agentCmdOverrides: { claude: 'claude-base' },
    agentCopies: [copy, { id: 'codex.other', name: 'Other', agent: 'codex' }]
  } as unknown as GlobalSettings
  const copies = {
    list: settings.agentCopies ?? [],
    created: null,
    duplicate: vi.fn(),
    mutate: vi.fn(() => vi.fn(async () => {})),
    saveEnvironment: vi.fn(() => vi.fn(async () => {})),
    rename: vi.fn(async () => {}),
    setChat: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  } satisfies ReturnType<typeof useAgentCopySettings>
  const scopes: AgentCardScope[] = []
  const rows = agentCopyCardRows({
    local: local
      ? { settings, saveEnvironment: vi.fn(async () => {}), updateSettings: vi.fn() }
      : undefined,
    copies,
    platform: 'linux',
    card: (scope) => {
      scopes.push(scope)
      return (agent): AgentCatalogRowProps =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the builder only spreads and overrides the base card's props.
        ({
          agentId: agent.id,
          label: agent.label,
          isSavedDefault: true,
          defaultMark: 'chosen',
          cliUpdate: 'update',
          opensAs: { value: 'chat', cliMissing: false, onChange: vi.fn() }
        }) as unknown as AgentCatalogRowProps
    }
  })(claude, true)
  return { rows, copies, scopes }
}

describe("an agent copy's card", () => {
  it("is its agent's card on the copy's own settings, under the copy's name and id", () => {
    const { rows, scopes } = setup()
    expect(rows.map((row) => [row.rowId, row.label])).toEqual([['claude.haiku', 'Claude Haiku']])
    expect(scopes[0]?.local?.settings.agentCmdOverrides).toEqual({ claude: '/opt/haiku/claude' })
    expect(rows[0]).toMatchObject({
      agentId: 'claude',
      isSavedDefault: false,
      defaultMark: null,
      cliUpdate: undefined,
      copy: { baseLabel: 'Claude' }
    })
  })

  it("saves its Chat | CLI pick, on/off and delete into the copy, never into its agent's", () => {
    const { rows, copies, scopes } = setup()
    const row = rows[0]!
    row.opensAs?.onChange('chat')
    row.onSetEnabled(false)
    row.copy?.onDelete()
    expect(copies.setChat).toHaveBeenCalledWith('claude.haiku', true)
    expect(copies.setEnabled).toHaveBeenCalledWith('claude.haiku', false)
    expect(copies.remove).toHaveBeenCalledWith('claude.haiku')
    expect(copies.mutate).toHaveBeenCalledWith('claude.haiku')
    void scopes[0]?.local?.updateSettings({ nativeChatProviders: { claude: true } })
    expect(copies.setChat).toHaveBeenCalledTimes(1)
  })

  it("is absent on a paired host's page", () => {
    expect(setup(false).rows).toEqual([])
  })
})
