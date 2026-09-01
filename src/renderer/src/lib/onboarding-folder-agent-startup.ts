import { isTuiAgentEnabled, toLegacyAutoPreference } from '../../../shared/tui-agent-selection'
import type { WorktreeStartupPayload } from '@/lib/worktree-activation'
import type { GlobalSettings, OnboardingState } from '../../../shared/types'

export function buildOnboardingFolderAgentStartup(
  settings: GlobalSettings | null
): WorktreeStartupPayload | undefined {
  // Why: onboarding/non-git-folder seeds an agent tab ONLY when the user picked a
  // concrete, enabled default agent. Auto ('auto'/legacy null) and Blank must seed
  // no agent (a plain terminal), so the gate stays client-side — a `{kind:'default'}`
  // request would let the host auto-pick a detected agent on Auto, which this
  // surface must not do.
  const agent = toLegacyAutoPreference(settings?.defaultTuiAgent)
  if (
    !settings ||
    !agent ||
    agent === 'blank' ||
    !isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  ) {
    return undefined
  }

  // Identity-only launch: the host resolves the command, config, and token from
  // the current default; the client never assembles argv/env. `launchAgent` is
  // the tab's identity hint until the host resolves.
  return {
    command: '',
    launchAgent: agent,
    agentLaunch: { selection: { kind: 'default' }, allowEmptyPromptLaunch: true },
    telemetry: {
      // No agent_kind: a custom default has no client-known kind, and the host
      // stamps it from the resolved receipt before the emit.
      launch_source: 'onboarding',
      request_kind: 'new'
    }
  }
}

export function shouldSeedFolderAgentAfterDismissedOnboarding(
  onboarding: OnboardingState | null,
  hasExistingProject: boolean
): boolean {
  return (
    onboarding?.outcome === 'dismissed' &&
    !hasExistingProject &&
    !onboarding.checklist.addedRepo &&
    !onboarding.checklist.addedFolder
  )
}

export function buildDismissedOnboardingFolderAgentStartup(
  settings: GlobalSettings | null,
  onboarding: OnboardingState | null,
  hasExistingProject: boolean
): WorktreeStartupPayload | undefined {
  if (!shouldSeedFolderAgentAfterDismissedOnboarding(onboarding, hasExistingProject)) {
    return undefined
  }
  return buildOnboardingFolderAgentStartup(settings)
}
