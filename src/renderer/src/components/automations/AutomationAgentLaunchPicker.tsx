import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { useAgentPickerDraftScope } from '@/components/agent/AgentLaunchSetupButton'
import { useAgentLaunchPickerInventory } from '@/components/agent/use-agent-launch-picker-inventory'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  buildAgentLaunchRouteInput,
  selectAgentLaunchRouteView,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/automation-runtime-capabilities'
import { applyAutomationLaunchSetupPatch } from '../../../../shared/automation-launch-setup'
import {
  automationLaunchChoices,
  automationArgumentChoices
} from '../../../../shared/automation-launch-setup-source'
import { mergeExtraAgentArgs } from '../../../../shared/automation-extra-agent-args'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { NewTabAgentMenuModel } from '@/components/tab-bar/new-tab-agent-menu-model'
import { automationChatSupport } from './automation-launch-surface'
import { AutomationExtraAgentArgsField } from './AutomationExtraAgentArgsField'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

export function AutomationAgentLaunchPicker({
  draft,
  workspace,
  visibleAgents,
  settings,
  surface,
  chatSupported,
  onDraftChange
}: {
  draft: AutomationDraft
  workspace: ProspectiveWorkspace
  visibleAgents: AgentCatalogEntry[]
  settings: GlobalSettings | null
  surface: 'chat' | 'terminal'
  chatSupported: boolean | null
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}) {
  const state = useAppStore(selectAgentLaunchRouteView)
  const [menuOpen, setMenuOpen] = useState(false)
  const [catalogAgent, setCatalogAgent] = useState<AgentPickerEntry['agent']>()
  const route = buildAgentLaunchRouteInput(state, { agent: draft.agentId, workspace })
  const host = parseExecutionHostId(route.executionHostId)
  const detectionTarget: AgentDetectionTarget | undefined =
    host?.kind === 'runtime'
      ? { kind: 'runtime', environmentId: host.environmentId, worktreeId: workspace.worktreeId }
      : host?.kind === 'ssh'
        ? { kind: 'ssh', connectionId: host.targetId }
        : host?.kind === 'local'
          ? { kind: 'local', worktreeId: workspace.worktreeId }
          : undefined
  const observation = useAgentMenuObservation({ workspace }, menuOpen, detectionTarget)
  const modern =
    route.hostCapabilities?.includes(AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY) === true
  const model: NewTabAgentMenuModel = useMemo(
    () => ({
      ...(observation.model.state === 'settled'
        ? observation.model
        : {
            state: 'settled' as const,
            detection: observation.detection,
            pickerContext: {
              workspace,
              executionHostId: route.executionHostId,
              settings: host?.kind === 'local' ? settings : null,
              key: observation.contextKey
            }
          }),
      // Automation authors a future launch, independently of today's detected installation.
      rows: visibleAgents.map(({ id }) => ({
        kind: 'cli' as const,
        agent: id,
        executionHostId: host?.id
      }))
    }),
    [
      observation.model,
      observation.detection,
      observation.contextKey,
      visibleAgents,
      host?.id,
      host?.kind,
      route.executionHostId,
      settings,
      workspace
    ]
  )

  const observed = useAgentLaunchPickerInventory(
    workspace.worktreeId,
    model,
    modern && menuOpen,
    catalogAgent ?? draft.agentId
  )
  const entries = observed.map((entry): AgentPickerEntry => {
    const chat =
      automationChatSupport(state, { ...draft, agentId: entry.agent }, workspace) === true
    const merged =
      surface === 'terminal' && draft.extraAgentArgs && entry.agent === draft.agentId
        ? mergeExtraAgentArgs({
            agent: entry.agent,
            defaultArgs: entry.arguments,
            extraAgentArgs: draft.extraAgentArgs,
            shell: 'posix'
          })
        : undefined
    return {
      ...entry,
      label: visibleAgents.find((agent) => agent.id === entry.agent)?.label ?? entry.label,
      surfaces: chat ? ['chat', 'terminal'] : ['terminal'],
      defaultSurface: entry.agent === draft.agentId ? surface : entry.defaultSurface,
      ...(merged?.ok ? { arguments: merged.agentArgs } : {})
    }
  })
  const scope = useAgentPickerDraftScope(JSON.stringify([workspace, draft.agentId]))
  const draftForEntry = (entry: AgentPickerEntry): AgentPickerDraft => {
    const own = entry.agent === draft.agentId ? draft : undefined
    const preferences = own?.launchPreferences
    return {
      agent: entry.agent,
      surface: own ? surface : entry.defaultSurface,
      choices: own ? automationLaunchChoices(own) : {},
      ...(own?.agentArgs !== undefined
        ? { arguments: own.agentArgs, argumentsOwner: entry.ownerKey }
        : {}),
      delegated: [
        ...(preferences?.model === null ? ['model'] : []),
        ...Object.entries(preferences?.options ?? {}).flatMap(([key, value]) =>
          value === null ? [key] : []
        )
      ]
    }
  }
  return (
    <>
      <AgentLaunchPicker
        model={model}
        entries={entries}
        agent={draft.agentId}
        draftScope={scope}
        triggerLabel={
          visibleAgents.find((agent) => agent.id === draft.agentId)?.label ?? draft.agentId
        }
        setupDisabled={!modern}
        draftForEntry={draftForEntry}
        onOpenChange={setMenuOpen}
        onCatalogOpen={setCatalogAgent}
        onPick={(agentId, accepted, _entry, pickedSurface) =>
          onDraftChange((current) => {
            const rebound = current.agentId !== agentId
            const edits = accepted?.acceptedEdits
            const patch = {
              ...(rebound
                ? modern
                  ? {
                      copy: {
                        surface: pickedSurface ?? surface,
                        ...(current.extraAgentArgs
                          ? { extraAgentArgs: current.extraAgentArgs }
                          : {})
                      }
                    }
                  : {}
                : current.launchSetupPatch),
              ...(pickedSurface ? { surface: pickedSurface } : {}),
              ...(edits
                ? {
                    choices: {
                      ...(rebound ? {} : current.launchSetupPatch?.choices),
                      ...edits.choices,
                      options: {
                        ...(rebound ? {} : current.launchSetupPatch?.choices?.options),
                        ...edits.choices.options
                      }
                    },
                    ...(edits.arguments !== undefined
                      ? {
                          arguments:
                            edits.arguments === null
                              ? { kind: 'empty' as const }
                              : { kind: 'value' as const, value: edits.arguments }
                        }
                      : {})
                  }
                : {})
            }
            if (edits?.arguments !== undefined && patch.choices) {
              const source = automationArgumentChoices(agentId, edits.arguments ?? '')
              for (const occurrence of source.recognized) {
                if (occurrence.key === 'model') {
                  delete patch.choices.model
                } else if (occurrence.key === 'permissionMode') {
                  delete patch.choices.permissionMode
                } else if (patch.choices.options) {
                  delete patch.choices.options[occurrence.key]
                }
              }
              Object.assign(patch.choices, edits.choices, {
                options: { ...patch.choices.options, ...edits.choices.options }
              })
            }
            const setup = applyAutomationLaunchSetupPatch(
              { agentId, launchSetupPatch: Object.keys(patch).length ? patch : undefined },
              current
            )
            return {
              ...current,
              agentId,
              ...(pickedSurface ? { surface: pickedSurface } : {}),
              launchPreferences: setup.launchPreferences,
              agentArgs: setup.agentArgs,
              extraAgentArgs: setup.extraAgentArgs ?? '',
              launchSetupPatch: Object.keys(patch).length ? patch : undefined
            }
          })
        }
      />
      {!modern ? (
        <>
          <AutomationSurfaceField
            draft={draft}
            settings={settings}
            supported={chatSupported}
            onDraftChange={onDraftChange}
          />
          {surface === 'terminal' ? (
            <AutomationExtraAgentArgsField draft={draft} onDraftChange={onDraftChange} />
          ) : null}
        </>
      ) : null}
    </>
  )
}
