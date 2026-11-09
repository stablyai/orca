import { useCallback, useMemo, useState, type ComponentProps } from 'react'
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
} from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import type { AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/automations/automation-runtime-capabilities'
import { automationLegacyArguments } from '../../../../shared/automations/launch/automation-legacy-arguments'
import type { AutomationAuthorityRef } from '../../../../shared/automations/ownership/automation-owner-ref'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { draftExtraAgentArgsNeedFreshSession } from './automation-draft-model'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuModel } from '@/components/tab-bar/new-tab-agent-menu-model'
import { useAutomationAgentPickerEntries } from './use-automation-agent-picker-entries'
import { AutomationExtraAgentArgsField } from './AutomationExtraAgentArgsField'
import { AutomationSurfaceField } from './AutomationSurfaceField'
import type { AutomationDraft } from './AutomationEditorDialog'
import {
  pickAutomationLaunch,
  editAutomationLegacyDraft,
  editsSupplementalArguments
} from './automation-launch-draft'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

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
  const t = useTranslate()
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
  const { entries, draftForEntry } = useAutomationAgentPickerEntries(
    observed,
    state,
    draft,
    workspace,
    visibleAgents,
    surface
  )
  const scope = useAgentPickerDraftScope(JSON.stringify([workspace, authority, draft.agentId]))
  const onPick = useCallback<ComponentProps<typeof AgentLaunchPicker>['onPick']>(
    (agentId, accepted, _entry, pickedSurface) =>
      onDraftChange((current) =>
        pickAutomationLaunch(current, agentId, accepted, pickedSurface, modern, surface)
      ),
    [onDraftChange, modern, surface]
  )
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
        onPick={onPick}
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
            {t(
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
            {t('auto.components.automations.extraAgentArgs.useFreshSessions', 'Use fresh sessions')}
          </Button>
        </div>
      ) : null}
    </>
  )
}
