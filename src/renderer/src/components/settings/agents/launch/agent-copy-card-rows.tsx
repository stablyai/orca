import {
  applyAgentCopy,
  type AgentCopy
} from '../../../../../../shared/agent-launch/catalog/agent-copies'
import {
  projectAgentLaunchSettings,
  type AgentLaunchSettings,
  type AgentLaunchSettingsMutation
} from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import type { AgentCatalogRowProps } from './AgentCatalogRow'
import { AgentCopyIdentityFields } from './AgentCopyIdentityFields'
import type { useAgentCopySettings } from './use-agent-copy-settings'

export type LocalAgentSettings = {
  settings: GlobalSettings
  saveEnvironment: (agent: TuiAgent, value: Record<string, string>) => Promise<void>
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

/** What one card reads and writes: an agent's own settings, or an agent copy's settings as they
 *  fill its agent's slots, so a copy's card is its agent's card. */
export type AgentCardScope = {
  settings: AgentLaunchSettings
  mutate: (mutation: AgentLaunchSettingsMutation) => Promise<void>
  local?: LocalAgentSettings
}

type AgentCardRows = (agent: AgentCatalogEntry, listedInstalled: boolean) => AgentCatalogRowProps

/** The cards of `agent`'s copies: each is its agent's card built on the copy's own settings, with
 *  the copy's name, ID, Chat | CLI pick and Delete. A paired host's page has no copies. */
export function agentCopyCardRows(args: {
  local: LocalAgentSettings | undefined
  copies: ReturnType<typeof useAgentCopySettings>
  platform: NodeJS.Platform
  card: (scope: AgentCardScope) => AgentCardRows
}): (agent: AgentCatalogEntry, listedInstalled: boolean) => AgentCatalogRowProps[] {
  const { local, copies, platform, card } = args
  const copyRow = (
    base: LocalAgentSettings,
    agent: AgentCatalogEntry,
    copy: AgentCopy,
    listedInstalled: boolean
  ): AgentCatalogRowProps => {
    const view = applyAgentCopy(base.settings, copy)
    const row = card({
      settings: projectAgentLaunchSettings(view, platform),
      mutate: copies.mutate(copy.id),
      local: {
        settings: view,
        saveEnvironment: copies.saveEnvironment(copy.id),
        // The copy's surface is saved by its own Chat | CLI handler below, never into its agent's.
        updateSettings: () => {}
      }
    })(agent, listedInstalled)
    return {
      ...row,
      rowId: copy.id,
      label: copy.name,
      isEnabled: !copy.disabled,
      defaultMark: null,
      isSavedDefault: false,
      onSetEnabled: (enabled) => void copies.setEnabled(copy.id, enabled).catch(() => {}),
      opensAs: row.opensAs && {
        ...row.opensAs,
        onChange: (value) => void copies.setChat(copy.id, value === 'chat').catch(() => {})
      },
      // The agent's card already offers its CLI update, chat program and history folder.
      cliUpdate: undefined,
      chatRuntime: undefined,
      sessionSourceHome: undefined,
      onDuplicate: () => copies.duplicate(agent, copy),
      initiallyExpanded: copies.created === copy.id,
      copy: {
        baseLabel: agent.label,
        onDelete: () => void copies.remove(copy.id).catch(() => {}),
        identity: (
          <AgentCopyIdentityFields
            key={copy.id}
            copy={copy}
            taken={copies.list.filter((other) => other.id !== copy.id).map((other) => other.id)}
            onChange={(identity) => copies.rename(copy.id, identity)}
          />
        )
      }
    }
  }
  return (agent, listedInstalled) =>
    local
      ? copies.list
          .filter((copy) => copy.agent === agent.id)
          .map((copy) => copyRow(local, agent, copy, listedInstalled))
      : []
}
