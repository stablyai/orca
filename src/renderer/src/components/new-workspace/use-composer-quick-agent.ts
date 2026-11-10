import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { agentChoicePending } from '@/lib/host-chat-program'
import { useAgentsOfferedForLaunch } from '@/lib/host-chat-program-acquisition'
import {
  composerLaunchWorkspace,
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/quick-workspace-agent-selection'
import {
  ORCA_CLOUD_AGENT_IDS,
  orcaCloudAgentMenuModel,
  pickOrcaCloudAgent
} from '@/lib/orca-cloud/orca-cloud-agent-picker'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isOrcaCloudSelection } from './run-target-options'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type ComposerQuickAgentProps = Pick<
  NewWorkspaceComposerCardProps,
  | 'agentRows'
  | 'detectedAgentIds'
  | 'repoId'
  | 'selectedRepoIsGit'
  | 'selectedRepoExecutionHostId'
  | 'ephemeralVmRecipes'
  | 'selectedEphemeralVmRecipeId'
>

/** The composer's agent: the user's pick when the launch host can start it, else the default. */
export function useComposerQuickAgent(
  cardProps: ComposerQuickAgentProps,
  settings: GlobalSettings | null | undefined,
  quickAgentOverride: TuiAgent | null | undefined,
  setQuickAgentOverride: (agent: TuiAgent | null | undefined) => void
) {
  // The picker rows' workspace when known, so the offered list and the rows read one host.
  const launchWorkspace =
    cardProps.agentRows?.target.workspace ?? composerLaunchWorkspace(cardProps)
  const hostOfferedAgentIds = useAgentsOfferedForLaunch(launchWorkspace, cardProps.detectedAgentIds)
  // Orca Cloud has no VM yet: the image's agents are its inventory, never this desktop's CLIs.
  const orcaCloud = isOrcaCloudSelection(cardProps)
  const orcaCloudModel = useMemo(
    () => (orcaCloud ? orcaCloudAgentMenuModel(settings) : null),
    [orcaCloud, settings]
  )
  const detectedAgentIds = orcaCloud ? ORCA_CLOUD_AGENT_IDS : cardProps.detectedAgentIds
  const offeredAgentIds = orcaCloud ? ORCA_CLOUD_AGENT_IDS : hostOfferedAgentIds
  const detected = detectedAgentIds ? [...detectedAgentIds] : null
  const choicePending = (agent: TuiAgent): boolean =>
    !orcaCloud && agentChoicePending(useAppStore.getState(), agent, launchWorkspace, detected)
  // Pending discovery preserves the existing catalog fallback; current facts settle the default.
  const preferredQuickAgent = orcaCloud
    ? pickOrcaCloudAgent(settings?.defaultTuiAgent, settings?.disabledTuiAgents)
    : pickQuickWorkspaceAgent(
        settings?.defaultTuiAgent,
        detectedAgentIds,
        settings?.disabledTuiAgents,
        offeredAgentIds,
        choicePending
      )
  // An explicit pick stays valid where it opens as a chat without its CLI.
  const resolved = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride,
    preferredQuickAgent,
    detectedAgentIds,
    offeredAgentIds,
    selectedChoiceUnresolved: Boolean(quickAgentOverride && choicePending(quickAgentOverride)),
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (resolved.quickAgentOverride !== quickAgentOverride) {
    // Repair invalid picks (e.g. a local-only agent once Orca Cloud is chosen) before children render it.
    setQuickAgentOverride(resolved.quickAgentOverride)
  }
  const quickAgent = resolved.quickAgent
  // Chips list offered agents, keeping a pick whose chat is still being learned.
  const chipAgentIds =
    offeredAgentIds &&
    new Set([...offeredAgentIds, ...(quickAgent && choicePending(quickAgent) ? [quickAgent] : [])])
  return { orcaCloud, orcaCloudModel, quickAgent, chipAgentIds }
}
