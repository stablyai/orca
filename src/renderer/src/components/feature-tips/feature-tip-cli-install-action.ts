import type { CliInstallStatus } from '../../../../shared/cli-install-types'

export type FeatureTipCliInstallResult =
  | { kind: 'installed'; status: CliInstallStatus }
  | { kind: 'needs-attention'; status: CliInstallStatus }

export async function installCliFromFeatureTip(
  installCli: () => Promise<CliInstallStatus>
): Promise<FeatureTipCliInstallResult> {
  const status = await installCli()
  if (status.state === 'installed' && status.pathConfigured === true) {
    return { kind: 'installed', status }
  }
  return { kind: 'needs-attention', status }
}
