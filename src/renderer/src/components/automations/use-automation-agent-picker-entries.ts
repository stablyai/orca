import { useCallback, useMemo } from 'react'
import { shallow } from 'zustand/shallow'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type {
  AgentLaunchRouteStore,
  ProspectiveWorkspace
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { automationLaunchChoices } from '../../../../shared/automation-launch-setup-source'
import { mergeExtraAgentArgs } from '../../../../shared/agent-launch/startup/automation-extra-agent-args'
import type { AutomationDraft } from './AutomationEditorDialog'
import { automationChatSupport } from './automation-launch-surface'

type Projection = { signature: unknown[]; entry: AgentPickerEntry; draft: AgentPickerDraft }

export function useAutomationAgentPickerEntries(
  observed: AgentPickerEntry[],
  state: AgentLaunchRouteStore,
  draft: AutomationDraft,
  workspace: ProspectiveWorkspace,
  visibleAgents: AgentCatalogEntry[],
  surface: 'chat' | 'terminal'
) {
  const projections = useMemo(() => new WeakMap<AgentPickerEntry, Projection>(), [])
  const entries = observed.map((entry): AgentPickerEntry => {
    const own = entry.agent === draft.agentId
    const chat =
      automationChatSupport(state, { ...draft, agentId: entry.agent }, workspace) === true
    const label = visibleAgents.find((agent) => agent.id === entry.agent)?.label ?? entry.label
    const defaultSurface = own ? surface : entry.defaultSurface
    const merged =
      surface === 'terminal' && draft.extraAgentArgs && own
        ? mergeExtraAgentArgs({
            agent: entry.agent,
            defaultArgs: entry.arguments,
            extraAgentArgs: draft.extraAgentArgs,
            shell: 'posix'
          })
        : undefined
    const args = merged?.ok ? merged.agentArgs : entry.arguments
    const preferences = own ? draft.launchPreferences : undefined
    const signature = [label, chat, defaultSurface, args, own, preferences, own && draft.agentArgs]
    const previous = projections.get(entry)
    if (previous && shallow(previous.signature, signature)) {
      return previous.entry
    }
    const projected: AgentPickerEntry = {
      ...entry,
      label,
      surfaces: chat ? ['chat', 'terminal'] : ['terminal'],
      defaultSurface,
      arguments: args
    }
    const projection: Projection = {
      signature,
      entry: projected,
      draft: {
        agent: entry.agent,
        surface: defaultSurface,
        choices: own ? automationLaunchChoices(draft) : {},
        ...(own && draft.agentArgs !== undefined
          ? { arguments: draft.agentArgs, argumentsOwner: entry.ownerKey }
          : {}),
        delegated: [
          ...(preferences?.model === null ? ['model'] : []),
          ...Object.entries(preferences?.options ?? {}).flatMap(([key, value]) =>
            value === null ? [key] : []
          )
        ]
      }
    }
    projections.set(entry, projection)
    projections.set(projected, projection)
    return projected
  })
  const draftForEntry = useCallback(
    (entry: AgentPickerEntry) => projections.get(entry)?.draft ?? agentPickerDraft(entry),
    [projections]
  )
  return { entries, draftForEntry }
}
