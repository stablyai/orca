import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { isOrcaCliRegistrationRequired } from '@/lib/agent-skill-cli-prerequisite'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'

export type OnboardingCliRegistrationDeps = {
  getCliStatus: () => Promise<CliInstallStatus>
  showCliRegistrationPrompt?: () => Promise<void>
  installCli: () => Promise<CliInstallStatus>
}

export type OnboardingCliRegistrationResult = {
  touched: boolean
  warning: string | null
}

/** Registers the CLI when this runtime's terminals can't reach the bundled one and it is missing. */
export async function registerOnboardingCliIfRequired(
  agentRuntime: ProjectAgentSkillRuntime | undefined,
  deps: OnboardingCliRegistrationDeps
): Promise<OnboardingCliRegistrationResult> {
  if (!isOrcaCliRegistrationRequired(agentRuntime)) {
    return { touched: false, warning: null }
  }
  try {
    const status = await deps.getCliStatus()
    if (!status.supported) {
      return {
        touched: false,
        warning: status.detail ?? 'Orca CLI registration is not available on this platform.'
      }
    }
    if (status.pathConfigured === null) {
      // Why: an unknown PATH read cannot safely drive a PATH read-modify-write.
      return { touched: false, warning: status.detail ?? 'Orca could not check your PATH.' }
    }
    if (status.state === 'installed' && status.pathConfigured) {
      return { touched: false, warning: null }
    }
    await deps.showCliRegistrationPrompt?.()
    const next = await deps.installCli()
    if (next.state !== 'installed') {
      return { touched: true, warning: next.detail ?? 'Orca CLI registration needs attention.' }
    }
    return { touched: true, warning: next.pathConfigured === true ? null : next.detail }
  } catch (error) {
    return { touched: false, warning: error instanceof Error ? error.message : String(error) }
  }
}
