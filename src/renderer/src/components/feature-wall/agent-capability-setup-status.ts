import { useEffect, useMemo, useState } from 'react'
import type {
  OnboardingFeatureSetupId,
  OnboardingFeatureSetupSelection
} from '../onboarding/onboarding-feature-setup'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { translate } from '@/i18n/i18n'

export type AgentCapabilityInstallStatusTone = 'ready' | 'pending' | 'checking' | 'error'

export type AgentCapabilityInstallStatus = {
  label: string
  tone: AgentCapabilityInstallStatusTone
  installed?: boolean
}

export type AgentCapabilityReadiness = {
  browserUseSkillInstalled: boolean
  browserUseSkillLoading: boolean
  computerUseSkillInstalled: boolean
  computerUseSkillLoading: boolean
  computerUseReady: boolean
  computerUseChecking: boolean
  computerUseUnavailable: boolean
  orchestrationSkillInstalled: boolean
  orchestrationSkillLoading: boolean
}

export type AgentCapabilitySetupStatus = {
  readiness: AgentCapabilityReadiness
  installStatus: Record<OnboardingFeatureSetupId, AgentCapabilityInstallStatus>
}

export function useAgentCapabilitySetupStatus(): AgentCapabilitySetupStatus {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const browserUseSkill = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const computerUseSkill = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const orchestrationSkill = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const computerUsePermissionStatus = useComputerUsePermissionStatus(computerUseSkill.installed)
  const readiness: AgentCapabilityReadiness = useMemo(
    () => ({
      browserUseSkillInstalled: browserUseSkill.installed,
      browserUseSkillLoading: browserUseSkill.loading,
      computerUseSkillInstalled: computerUseSkill.installed,
      computerUseSkillLoading: computerUseSkill.loading,
      computerUseReady: computerUsePermissionStatus.ready,
      computerUseChecking: computerUsePermissionStatus.checking,
      computerUseUnavailable: computerUsePermissionStatus.unavailableReason !== null,
      orchestrationSkillInstalled: orchestrationSkill.installed,
      orchestrationSkillLoading: orchestrationSkill.loading
    }),
    [
      browserUseSkill.installed,
      browserUseSkill.loading,
      computerUsePermissionStatus.checking,
      computerUsePermissionStatus.ready,
      computerUsePermissionStatus.unavailableReason,
      computerUseSkill.installed,
      computerUseSkill.loading,
      orchestrationSkill.installed,
      orchestrationSkill.loading
    ]
  )

  const installStatus = useMemo(
    () => ({
      browserUse: getSkillInstallStatus(browserUseSkill),
      computerUse: getComputerUseInstallStatus(computerUseSkill, computerUsePermissionStatus),
      orchestration: getSkillInstallStatus(orchestrationSkill),
      // Why: linearTickets remains in the onboarding selection shape, but the
      // generic feature wall must not become a Linear skill install surface.
      linearTickets: getFeatureWallExcludedLinearTicketsStatus()
    }),
    [browserUseSkill, computerUsePermissionStatus, computerUseSkill, orchestrationSkill]
  )

  return { readiness, installStatus }
}

export function getDefaultAgentCapabilitySetupSelection(
  readiness: AgentCapabilityReadiness
): OnboardingFeatureSetupSelection {
  return {
    browserUse: !readiness.browserUseSkillInstalled,
    // Why: Computer Use has OS permission setup in addition to the skill install.
    // Keep it selected when permissions still need action, even if the skill exists.
    computerUse:
      !readiness.computerUseSkillInstalled ||
      (!readiness.computerUseReady && !readiness.computerUseUnavailable),
    orchestration: !readiness.orchestrationSkillInstalled,
    linearTickets: false
  }
}

export function isAgentCapabilityReadinessChecking(readiness: AgentCapabilityReadiness): boolean {
  return (
    readiness.browserUseSkillLoading ||
    readiness.computerUseSkillLoading ||
    (readiness.computerUseSkillInstalled && readiness.computerUseChecking) ||
    readiness.orchestrationSkillLoading
  )
}

export function getAgentCapabilityStatusClassName(tone: AgentCapabilityInstallStatusTone): string {
  switch (tone) {
    case 'ready':
      return 'text-green-600 dark:text-green-300'
    case 'error':
      return 'text-destructive'
    case 'checking':
    case 'pending':
      return 'text-muted-foreground'
  }
}

function getSkillInstallStatus(skill: {
  installed: boolean
  loading: boolean
  error: string | null
}): AgentCapabilityInstallStatus {
  if (skill.loading) {
    return {
      label: translate(
        'auto.components.feature.wall.agent.capability.setup.status.9b33e7fb13',
        'Checking install'
      ),
      tone: 'checking'
    }
  }
  if (skill.error) {
    return {
      label: translate(
        'auto.components.feature.wall.agent.capability.setup.status.aa8e143a2f',
        'Could not check install'
      ),
      tone: 'error'
    }
  }
  if (skill.installed) {
    return {
      label: translate(
        'auto.components.feature.wall.agent.capability.setup.status.8eccfcb314',
        'Installed'
      ),
      tone: 'ready',
      installed: true
    }
  }
  return {
    label: translate(
      'auto.components.feature.wall.agent.capability.setup.status.aae94eeb52',
      'Click Install CLI & Skills'
    ),
    tone: 'pending'
  }
}

function getFeatureWallExcludedLinearTicketsStatus(): AgentCapabilityInstallStatus {
  return {
    label: '',
    tone: 'pending'
  }
}

function getComputerUseInstallStatus(
  skill: {
    installed: boolean
    loading: boolean
    error: string | null
  },
  permissions: {
    ready: boolean
    checking: boolean
    unavailableReason: string | null
  }
): AgentCapabilityInstallStatus {
  const skillStatus = getSkillInstallStatus(skill)
  if (skillStatus.tone !== 'ready') {
    return skillStatus
  }
  if (permissions.checking) {
    return {
      label: translate(
        'auto.components.feature.wall.agent.capability.setup.status.5c9293e51a',
        'checking app access'
      ),
      tone: 'checking',
      installed: true
    }
  }
  if (permissions.unavailableReason) {
    return {
      label:
        permissions.unavailableReason === 'web_client'
          ? translate(
              'auto.components.feature.wall.agent.capability.setup.status.4c8e1f92a7',
              'open Orca Desktop on this Mac'
            )
          : translate(
              'auto.components.feature.wall.agent.capability.setup.status.6d2b0a84e1',
              'Unavailable in this build'
            ),
      tone: 'pending',
      installed: true
    }
  }
  if (!permissions.ready) {
    return {
      label: translate(
        'auto.components.feature.wall.agent.capability.setup.status.21d4f79c93',
        'click Install CLI & Skills to open macOS access settings'
      ),
      tone: 'pending',
      installed: true
    }
  }
  return {
    label: translate(
      'auto.components.feature.wall.agent.capability.setup.status.8eccfcb314',
      'Installed'
    ),
    tone: 'ready',
    installed: true
  }
}

function useComputerUsePermissionStatus(enabled: boolean): {
  ready: boolean
  checking: boolean
  unavailableReason: string | null
} {
  const [status, setStatus] = useState<{
    ready: boolean
    checking: boolean
    unavailableReason: string | null
  }>({
    ready: false,
    checking: enabled,
    unavailableReason: null
  })

  useEffect(() => {
    if (!enabled) {
      setStatus({ ready: false, checking: false, unavailableReason: null })
      return
    }

    let stale = false
    const refresh = (): void => {
      setStatus((current) => ({ ...current, checking: true }))
      window.api.computerUsePermissions
        .getStatus()
        .then((next) => {
          if (stale) {
            return
          }
          setStatus({
            ready:
              next.helperUnavailableReason === null &&
              next.permissions.every((permission) => permission.status !== 'not-granted'),
            checking: false,
            unavailableReason: next.helperUnavailableReason
          })
        })
        .catch(() => {
          if (stale) {
            return
          }
          setStatus({ ready: false, checking: false, unavailableReason: null })
        })
    }

    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      stale = true
      window.removeEventListener('focus', refresh)
    }
  }, [enabled])

  return status
}
