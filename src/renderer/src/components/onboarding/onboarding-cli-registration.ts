import type { CliInstallStatus } from '../../../../shared/cli-install-types'

export type OnboardingCliRegistrationDeps = {
  getCliStatus: () => Promise<CliInstallStatus>
  showCliRegistrationPrompt?: () => Promise<void>
  installCli: () => Promise<CliInstallStatus>
}

export type OnboardingCliRegistrationResult = {
  touched: boolean
  warning: string | null
}

/** Registers the CLI when it is missing; callers gate this on isOrcaCliRegistrationRequired. */
export async function registerOnboardingCli(
  deps: OnboardingCliRegistrationDeps
): Promise<OnboardingCliRegistrationResult> {
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
