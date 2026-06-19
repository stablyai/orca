import { getAgentLabel } from '@/lib/agent-catalog'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  findTuiAgentProfile,
  isTuiAgentProfileDetected
} from '../../../../shared/tui-agent-profiles'
import type { TuiAgent, TuiAgentProfile } from '../../../../shared/types'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { translate } from '@/i18n/i18n'
import type { SourceControlAgentActionDeliveryPlanState } from './SourceControlAgentActionDialogForm'

export function isSourceControlAgentDetectedAndEnabled(
  agent: TuiAgent | null,
  detectedAgents: TuiAgent[],
  disabledAgents: TuiAgent[] | undefined,
  profiles?: readonly TuiAgentProfile[] | null
): boolean {
  const profile = agent ? findTuiAgentProfile(agent, profiles) : null
  const detectedSet = new Set(detectedAgents)
  return Boolean(
    agent &&
    (profile ? isTuiAgentProfileDetected(profile, detectedSet) : detectedSet.has(agent)) &&
    isTuiAgentEnabled(agent, disabledAgents)
  )
}

export function buildSourceControlAgentSaveTargets(repoId?: string | null): {
  value: string
  label: string
}[] {
  const targets = [
    {
      value: 'none',
      label: translate(
        'auto.components.right.sidebar.SourceControlAgentActionDialog.994cddd1f7',
        "Don't save"
      )
    }
  ]
  if (repoId) {
    targets.push({
      value: 'repo',
      label: translate(
        'auto.components.right.sidebar.SourceControlAgentActionDialog.808cfe0a3b',
        'This repository'
      )
    })
  }
  targets.push({
    value: 'global',
    label: translate(
      'auto.components.right.sidebar.SourceControlAgentActionDialog.38b899cc02',
      'All repositories'
    )
  })
  return targets
}

export function getDefaultSourceControlAgentSaveTargetValue(): string {
  return 'global'
}

export function buildSourceControlAgentConnectionErrorPlan(): SourceControlAgentActionDeliveryPlanState {
  return {
    status: 'error',
    error: translate(
      'auto.components.right.sidebar.SourceControlAgentActionDialog.c075d00de1',
      'Unable to resolve the workspace connection.'
    )
  }
}

export function resolveSourceControlAgentSaveTarget(
  saveTargetValue: string,
  repoId?: string | null
): SourceControlAiWriteTarget | null {
  if (saveTargetValue === 'repo' && repoId) {
    return { type: 'repo', repoId }
  }
  if (saveTargetValue === 'global') {
    return { type: 'global' }
  }
  return null
}

export function buildSourceControlAgentStatusCopy(args: {
  selectedAgent: TuiAgent | null
  selectedAgentUnavailable: boolean
  connectionUnavailable: boolean
  hasEnabledAgents: boolean
  detecting: boolean
  profiles?: readonly TuiAgentProfile[] | null
}): string | null {
  const {
    selectedAgent,
    selectedAgentUnavailable,
    connectionUnavailable,
    hasEnabledAgents,
    detecting
  } = args
  if (selectedAgentUnavailable) {
    const label = selectedAgent ? getAgentLabel(selectedAgent, args.profiles) : selectedAgent
    return `${label} is not enabled or was not detected on this workspace host.`
  }
  if (connectionUnavailable) {
    return 'Unable to resolve the workspace connection.'
  }
  if (!hasEnabledAgents && !detecting) {
    return 'No enabled agents were detected on this workspace host.'
  }
  return null
}
