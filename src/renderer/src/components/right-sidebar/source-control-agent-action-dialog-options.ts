import { getAgentCatalogWithProfiles } from '@/lib/agent-catalog'
import type { SourceControlLaunchAgentScope } from '@/lib/source-control-launch-agent-selection'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { Repo, TuiAgent, TuiAgentProfile } from '../../../../shared/types'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { isSourceControlAgentDetectedAndEnabled } from './source-control-agent-action-dialog-support'

export function sourceControlLaunchSaveTargetFromValue(
  value: string,
  repo: Pick<Repo, 'id'> | null
): SourceControlAiWriteTarget | null {
  if (value === 'repo' && repo?.id) {
    return { type: 'repo', repoId: repo.id }
  }
  if (value === 'global') {
    return { type: 'global' }
  }
  return null
}

export function buildSourceControlAgentDialogOptions(args: {
  detectedAgents: TuiAgent[]
  disabledAgents?: TuiAgent[]
  selectedAgent: TuiAgent | null
  agentProfiles: readonly TuiAgentProfile[]
}): {
  enabledDetectedAgents: TuiAgent[]
  agentOptions: ReturnType<typeof getAgentCatalogWithProfiles>
  selectedAgentUnavailable: boolean
  hasEnabledAgents: boolean
} {
  const enabledDetectedAgents = args.detectedAgents.filter((agent) =>
    isTuiAgentEnabled(agent, args.disabledAgents)
  )
  const agentOptions = getAgentCatalogWithProfiles(args.agentProfiles).filter(
    (entry) =>
      isSourceControlAgentDetectedAndEnabled(
        entry.id,
        enabledDetectedAgents,
        args.disabledAgents,
        args.agentProfiles
      ) || entry.id === args.selectedAgent
  )
  const selectedAgentUnavailable = Boolean(
    args.selectedAgent &&
    !isSourceControlAgentDetectedAndEnabled(
      args.selectedAgent,
      args.detectedAgents,
      args.disabledAgents,
      args.agentProfiles
    )
  )
  return {
    enabledDetectedAgents,
    agentOptions,
    selectedAgentUnavailable,
    hasEnabledAgents: enabledDetectedAgents.length > 0
  }
}

export function buildSourceControlAgentScopeNote(args: {
  launchAgentScope: SourceControlLaunchAgentScope
  agentProfiles: readonly TuiAgentProfile[]
}): { effectiveAgentLabel: string; globalAgentLabel: string } | null {
  if (!args.launchAgentScope.overridesGlobalAgent) {
    return null
  }
  const catalog = getAgentCatalogWithProfiles(args.agentProfiles)
  const labelFor = (agentId: TuiAgent | null): string =>
    catalog.find((entry) => entry.id === agentId)?.label ?? agentId ?? ''
  return {
    effectiveAgentLabel: labelFor(args.launchAgentScope.effectiveAgentId),
    globalAgentLabel: labelFor(args.launchAgentScope.globalAgentId)
  }
}
