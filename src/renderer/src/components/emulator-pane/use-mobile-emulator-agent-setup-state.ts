import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

// Why: Orca terminals already provide the `orca` command, so agent control only needs the skill.
export function useMobileEmulatorAgentSetupState(enabled = true): {
  cliSkillError: string | null
  cliSkillInstalled: boolean
  cliSkillLoading: boolean
  recheckSetup: () => Promise<void>
  refreshCliSkill: () => Promise<boolean>
  setupComplete: boolean
  setupRechecking: boolean
  statusReady: boolean
} {
  const [setupRechecking, setSetupRechecking] = useState(false)
  const mountedRef = useMountedRef()
  const {
    installed: cliSkillInstalled,
    loading: cliSkillLoading,
    error: cliSkillError,
    refresh: refreshCliSkill
  } = useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
    enabled,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: users often install the skill from Settings or a terminal; refresh on focus.
    const handleFocus = (): void => {
      void refreshCliSkill()
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [enabled, refreshCliSkill])

  const recheckSetup = useCallback(async (): Promise<void> => {
    if (setupRechecking) {
      return
    }
    setSetupRechecking(true)
    try {
      const skillInstalled = await refreshCliSkill()
      if (!mountedRef.current) {
        return
      }
      if (skillInstalled) {
        toast.success(
          translate(
            'auto.components.emulator.pane.use.mobile.emulator.agent.setup.state.35dea1ae12',
            'Agent control is ready.'
          )
        )
        return
      }
      toast.message(
        translate(
          'auto.components.emulator.pane.use.mobile.emulator.agent.setup.state.skillNotInstalled',
          'The Orca CLI skill is not installed yet.'
        )
      )
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.emulator.pane.use.mobile.emulator.agent.setup.state.c94ff11e91',
                'Could not re-check setup status.'
              )
        )
      }
    } finally {
      if (mountedRef.current) {
        setSetupRechecking(false)
      }
    }
  }, [mountedRef, refreshCliSkill, setupRechecking])

  return {
    cliSkillError,
    cliSkillInstalled,
    cliSkillLoading,
    recheckSetup,
    refreshCliSkill,
    setupComplete: cliSkillInstalled,
    setupRechecking,
    statusReady: !cliSkillLoading
  }
}
