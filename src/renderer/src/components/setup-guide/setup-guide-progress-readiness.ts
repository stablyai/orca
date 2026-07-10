import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { ComputerUsePermissionStatusResult } from '../../../../shared/computer-use-permissions-types'
import type { GlobalSettings, Repo } from '../../../../shared/types'

export type SetupScriptProbeState = {
  signature: string | null
  ready: boolean
  hasSetupScript: boolean
}

export type SetupGuideProgressReadinessInput = {
  refreshEnabled: boolean
  settingsLoaded: boolean
  preflightStatusChecked: boolean
  linearStatusChecked: boolean
  jiraStatusChecked: boolean
  browserUseSkillDiscoveryLoading: boolean
  computerUseSkillDiscoveryLoading: boolean
  orchestrationSkillDiscoveryLoading: boolean
  setupScriptProbeReady: boolean
  computerUseSkillInstalled: boolean
  computerUsePermissionStatusChecked: boolean
}

export const INITIAL_SETUP_SCRIPT_PROBE_STATE: SetupScriptProbeState = {
  signature: null,
  ready: false,
  hasSetupScript: false
}

export function getSetupScriptProbeSignature(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  orderedGitRepos: readonly Pick<Repo, 'id' | 'hookSettings'>[]
): string | null {
  if (!settings) {
    return null
  }
  const target = getActiveRuntimeTarget(settings)
  return JSON.stringify({
    runtime: target.kind === 'environment' ? target.environmentId : 'local',
    repos: orderedGitRepos.map((repo) => ({
      id: repo.id,
      commandSourcePolicy: repo.hookSettings?.commandSourcePolicy ?? null,
      setup: repo.hookSettings?.scripts?.setup ?? null
    }))
  })
}

export function markSetupScriptProbePending(
  current: SetupScriptProbeState,
  signature: string | null
): SetupScriptProbeState {
  if (current.signature === signature) {
    return current
  }
  return { signature, ready: false, hasSetupScript: false }
}

export function settleSetupScriptProbe(
  current: SetupScriptProbeState,
  signature: string,
  hasSetupScript: boolean
): SetupScriptProbeState {
  if (current.signature !== signature) {
    return current
  }
  return { signature, ready: true, hasSetupScript }
}

export function getCurrentSetupScriptProbeState(
  current: SetupScriptProbeState,
  signature: string | null
): SetupScriptProbeState {
  if (current.signature === signature) {
    return current
  }
  return { signature, ready: false, hasSetupScript: false }
}

export function getSetupGuideProgressReady(input: SetupGuideProgressReadinessInput): boolean {
  return (
    input.refreshEnabled &&
    input.settingsLoaded &&
    input.preflightStatusChecked &&
    input.linearStatusChecked &&
    input.jiraStatusChecked &&
    !input.browserUseSkillDiscoveryLoading &&
    !input.computerUseSkillDiscoveryLoading &&
    !input.orchestrationSkillDiscoveryLoading &&
    input.setupScriptProbeReady &&
    (!input.computerUseSkillInstalled || input.computerUsePermissionStatusChecked)
  )
}

export function getComputerUsePermissionSetupState(
  status: ComputerUsePermissionStatusResult | null
): { ready: boolean; unavailable: boolean } {
  return {
    ready:
      status !== null &&
      status.helperUnavailableReason === null &&
      status.permissions.every((permission) => permission.status !== 'not-granted'),
    unavailable: status !== null && status.helperUnavailableReason !== null
  }
}
