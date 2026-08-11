import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { formatCliUserFacingDetail } from '@/lib/cli-emulator-user-facing-copy'
import { cliDetailOrFallback } from './onboarding-cli-detail'

type OnboardingCliEnsureDeps = {
  getCliStatus: () => Promise<CliInstallStatus>
  showCliRegistrationPrompt?: () => Promise<void>
  installCli: () => Promise<CliInstallStatus>
}

type OnboardingCliWarning = {
  featureId: 'cli'
  message: string
}

export async function ensureOnboardingCliRegistration(deps: OnboardingCliEnsureDeps): Promise<{
  cliTouched: boolean
  warnings: OnboardingCliWarning[]
}> {
  const warnings: OnboardingCliWarning[] = []
  let cliTouched = false
  try {
    const status = await deps.getCliStatus()
    if (!status.supported) {
      warnings.push({
        featureId: 'cli',
        message: cliDetailOrFallback(
          status.detail,
          'auto.components.onboarding.featureSetup.cliUnsupported',
          'Orca CLI registration is not available on this platform.'
        )
      })
      return { cliTouched, warnings }
    }
    if (status.pathConfigured === null) {
      // Why: an unknown registry read cannot safely drive a PATH read-modify-write.
      warnings.push({
        featureId: 'cli',
        message: cliDetailOrFallback(
          status.detail,
          'auto.components.onboarding.featureSetup.windowsPathUnknown',
          'Orca could not check your Windows user PATH.'
        )
      })
      return { cliTouched, warnings }
    }
    if (status.state !== 'installed' || status.pathConfigured === false) {
      await deps.showCliRegistrationPrompt?.()
      const next = await deps.installCli()
      cliTouched = true
      pushInstallWarnings(warnings, next)
    }
  } catch (error) {
    warnings.push({
      featureId: 'cli',
      message:
        error instanceof Error
          ? formatCliUserFacingDetail(error.message) || error.message
          : String(error)
    })
  }
  return { cliTouched, warnings }
}

function pushInstallWarnings(warnings: OnboardingCliWarning[], next: CliInstallStatus): void {
  if (next.state !== 'installed') {
    warnings.push({
      featureId: 'cli',
      message: cliDetailOrFallback(
        next.detail,
        'auto.components.onboarding.featureSetup.cliNeedsAttention',
        'Orca CLI registration needs attention.'
      )
    })
    return
  }
  if (next.pathConfigured !== true && next.detail) {
    warnings.push({
      featureId: 'cli',
      message: formatCliUserFacingDetail(next.detail) || next.detail
    })
  }
}
