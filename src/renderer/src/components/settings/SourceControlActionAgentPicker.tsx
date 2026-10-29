import { pickSourceControlLaunchAgent } from '../../../../shared/source-control-launch-agent-selection'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAppStore } from '@/store'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  sourceControlRepoAgentRows,
  savedSurfaceForPick,
  sourceControlAgentPickerSelection,
  type SourceControlAgentRows
} from '@/lib/source-control-agent-picker'
import { buildAgentLaunchRouteInput } from '@/lib/agent-launch-route-input'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

/** The shared surface rows configure a recipe here; they never start an agent. */
type PickerProps = {
  agent: TuiAgent | null
  surface?: SourceControlActionRecipe['surface']
  repoId?: string
  disabled?: boolean
  onPick: (agent: TuiAgent | null, choice: Pick<SourceControlActionRecipe, 'surface'>) => void
}

export function SourceControlActionAgentPicker(props: PickerProps) {
  const repo = useAppStore((state) => state.repos.find((repo) => repo.id === props.repoId) ?? null)
  const rows = props.repoId
    ? sourceControlRepoAgentRows(repo)
    : {
        target: { workspace: { kind: 'git-worktree' as const } },
        detectionTarget: { kind: 'local' as const }
      }
  const observation = useAgentMenuObservation(rows.target, !props.disabled, rows.detectionTarget)
  const canSaveSurface = canSaveSourceControlActionSurface(rows.target, props.agent ?? 'claude')
  return (
    <SourceControlActionAgentPickerView
      {...props}
      observation={observation}
      canSaveSurface={canSaveSurface}
    />
  )
}

export function canSaveSourceControlActionSurface(
  target: SourceControlAgentRows['target'],
  agent: TuiAgent = 'claude'
): boolean {
  const route = buildAgentLaunchRouteInput(useAppStore.getState(), {
    agent,
    workspace:
      typeof target === 'string' ? { kind: 'git-worktree', worktreeId: target } : target.workspace
  })
  return route.hostCapabilities?.includes(AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY) === true
}

export function sourceControlActionAgentPreview(
  observation: ReturnType<typeof useAgentMenuObservation>,
  agent: TuiAgent | null
) {
  return observation.preferencesPending || observation.detection.detectedIds === null
    ? { status: 'pending' as const }
    : {
        status: 'ready' as const,
        agent: pickSourceControlLaunchAgent({
          savedAgent: agent,
          defaultAgent: observation.preferences.defaultTuiAgent,
          disabledAgents: observation.preferences.disabledTuiAgents,
          detectedAgents: observation.detection.detectedIds
        })
      }
}

export function SourceControlActionAgentPickerView({
  observation,
  canSaveSurface,
  ...props
}: PickerProps & {
  observation: ReturnType<typeof useAgentMenuObservation>
  canSaveSurface: boolean
}) {
  const pickerSelection = sourceControlAgentPickerSelection(
    observation.model,
    observation.selectionFor(props.agent, props.surface === 'terminal' ? 'terminal' : undefined)
  )
  return (
    <AgentCombobox
      allowBlankTerminal
      blankLabel={translate(
        'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
        'Use default agent'
      )}
      disabled={props.disabled || !pickerSelection.ready}
      allowNarrowTrigger
      triggerClassName="w-full"
      agents={getAgentCatalog()}
      value={props.agent}
      onValueChange={(agent) => props.onPick(agent, {})}
      surfaceRows={{
        model: observation.model,
        selection: pickerSelection,
        contextKey: observation.contextKey,
        surface: props.surface,
        onPick: (agent, surface) =>
          props.onPick(agent, {
            surface: canSaveSurface
              ? savedSurfaceForPick(observation.model, agent, surface)
              : undefined
          })
      }}
    />
  )
}
