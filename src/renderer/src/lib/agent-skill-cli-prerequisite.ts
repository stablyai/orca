import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../shared/cli-install-types'

type EnsureOrcaCliAvailableOptions = {
  onStatusChange?: (status: CliInstallStatus) => void
}

export function isOrcaCliAvailableOnPath(status: CliInstallStatus | null | undefined): boolean {
  return status?.state === 'installed' && status.pathConfigured
}

export async function ensureOrcaCliAvailableForAgentSkillTerminal({
  onStatusChange
}: EnsureOrcaCliAvailableOptions = {}): Promise<CliInstallStatus | null> {
  try {
    const status = await window.api.cli.getInstallStatus()
    onStatusChange?.(status)

    if (!status.supported) {
      showCliPrerequisiteWarning(status)
      return status
    }

    if (status.state !== 'installed' || !status.pathConfigured) {
      const next = await window.api.cli.install()
      onStatusChange?.(next)
      showCliPrerequisiteWarning(next)
      return next
    }

    return status
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to register `orca` in PATH.')
    return null
  }
}

function showCliPrerequisiteWarning(status: CliInstallStatus): void {
  if (!status.supported) {
    toast.warning('Orca CLI registration is unavailable', {
      description: status.detail ?? 'Install the Orca CLI before running agent skill setup.'
    })
    return
  }

  if (status.state !== 'installed') {
    toast.warning('Orca CLI registration needs attention', {
      description: status.detail ?? 'Install the Orca CLI before running agent skill setup.'
    })
    return
  }

  if (!status.pathConfigured) {
    // Why: the skill installer opens a real shell; agents only get the expected
    // Orca affordances when that shell can resolve the `orca` command.
    toast.warning('`orca` is not visible on PATH yet', {
      description:
        status.detail ?? 'Restart your shell or add the Orca CLI directory to PATH before setup.'
    })
  }
}
