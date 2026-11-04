import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { useAgentPickerDraftScope } from '@/components/agent/AgentLaunchSetupButton'
import { useAgentLaunchPickerInventory } from '@/components/agent/use-agent-launch-picker-inventory'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  buildAgentLaunchRouteInput,
  selectAgentLaunchRouteView,
  resolveHostCapabilities,
  type ProspectiveWorkspace
} from '@/lib/agent-launch-route-input'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/automation-runtime-capabilities'
import {
  automationLaunchChoices,
  automationLegacyArguments
} from '../../../../shared/automation-launch-setup-source'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { draftExtraAgentArgsNeedFreshSession } from './automation-draft-model'
import {
  mergeExtraAgentArgs,
  parseExtraAgentArgs
} from '../../../../shared/automation-extra-agent-args'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentPickerDraft, AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import type { NewTabAgentMenuModel } from '@/components/tab-bar/new-tab-agent-menu-model'
import { automationChatSupport } from './automation-launch-surface'
import { AutomationExtraAgentArgsField } from './AutomationExtraAgentArgsField'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import type { AutomationDraft } from './AutomationEditorDialog'
import { pickAutomationLaunch, editAutomationLegacyDraft } from './automation-launch-draft'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

function editsSupplementalArguments(draft: AutomationDraft, modern: boolean): boolean {
  const input = draft.launchArgumentsInput
  return (
    modern &&
    !(
      input?.kind === 'legacy' &&
      !parseExtraAgentArgs({ agent: draft.agentId, extraAgentArgs: input.value }).ok
    )
  )
}

function legacyArgumentsDraft(draft: AutomationDraft): AutomationDraft {
  return {
    ...draft,
    extraAgentArgs:
      draft.launchArgumentsInput?.kind === 'legacy'
        ? draft.launchArgumentsInput.value
        : (automationLegacyArguments(draft.agentId, draft) ?? '')
  }
}

export function AutomationAgentLaunchPicker({
  draft,
  workspace,
  authority,
  visibleAgents,
  settings,
  surface,
  chatSupported,
  onDraftChange
}: {
  draft: AutomationDraft
  workspace: ProspectiveWorkspace
  authority?: AutomationAuthorityRef
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
  const capabilities =
    authority?.kind === 'desktop'
      ? [AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY]
      : authority?.kind === 'runtime'
        ? resolveHostCapabilities(state, `runtime:${authority.environmentId}`)
        : null
  const modern = capabilities?.includes(AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY) === true
  const supplemental = editsSupplementalArguments(draft, modern)
  const legacyDraft = supplemental
    ? {
        ...draft,
        extraAgentArgs:
          draft.launchArgumentsInput?.kind === 'supplemental'
            ? draft.launchArgumentsInput.value
            : draft.extraAgentArgs
      }
    : legacyArgumentsDraft(draft)
  const showLegacyArguments =
    surface === 'terminal' &&
    (!modern || Boolean(draft.extraAgentArgs || draft.launchArgumentsInput))
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
  const scope = useAgentPickerDraftScope(JSON.stringify([workspace, authority, draft.agentId]))
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
          onDraftChange((current) =>
            pickAutomationLaunch(current, agentId, accepted, pickedSurface, modern, surface)
          )
        }
      />
      {!modern ? (
        <AutomationSurfaceField
          draft={draft}
          settings={settings}
          supported={capabilities === null ? null : chatSupported}
          onDraftChange={onDraftChange}
        />
      ) : null}
      {showLegacyArguments ? (
        <AutomationExtraAgentArgsField
          draft={legacyDraft}
          onDraftChange={(update) =>
            onDraftChange((current) => {
              const supplemental = editsSupplementalArguments(current, modern)
              const visible = supplemental
                ? {
                    ...current,
                    extraAgentArgs:
                      current.launchArgumentsInput?.kind === 'supplemental'
                        ? current.launchArgumentsInput.value
                        : current.extraAgentArgs
                  }
                : legacyArgumentsDraft(current)
              const next = update(visible)
              if (next.extraAgentArgs === visible.extraAgentArgs) {
                return { ...current, reuseSession: next.reuseSession }
              }
              return {
                ...editAutomationLegacyDraft(current, next.extraAgentArgs, supplemental),
                reuseSession: next.reuseSession
              }
            })
          }
        />
      ) : modern && draftExtraAgentArgsNeedFreshSession({ ...draft, surface }) ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.automations.launchSettings.needsFreshSession',
              'Agent launch settings require a fresh session for every run.'
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={() => onDraftChange((current) => ({ ...current, reuseSession: false }))}
          >
            {translate(
              'auto.components.automations.extraAgentArgs.useFreshSessions',
              'Use fresh sessions'
            )}
          </Button>
        </div>
      ) : null}
    </>
  )
}
