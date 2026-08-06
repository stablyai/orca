import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../shared/cli-install-types'
import { translate } from '@/i18n/i18n'

type EnsureOrcaCliAvailableOptions = {
  onStatusChange?: (status: CliInstallStatus) => void
  registrationPromptDelayMs?: number
}

export const AGENT_SKILL_CLI_PREREQUISITE_NOTICE =
  'Before opening setup, Orca may show a system prompt to register the Orca CLI command on PATH.'

export const CLI_PREREQUISITE_REGISTRATION_TOAST = 'Orca needs to register its CLI on PATH.'
export const CLI_PREREQUISITE_REGISTRATION_TOAST_DESCRIPTION =
  'Approve the system prompt so skill setup can use the Orca CLI command.'

export function isOrcaCliAvailableOnPath(status: CliInstallStatus | null | undefined): boolean {
  return status?.state === 'installed' && status.pathConfigured === true
}

export async function ensureOrcaCliAvailableForAgentSkillTerminal({
  onStatusChange,
  registrationPromptDelayMs = 700
}: EnsureOrcaCliAvailableOptions = {}): Promise<CliInstallStatus | null> {
  try {
    const status = await window.api.cli.getInstallStatus()
    onStatusChange?.(status)

    if (!status.supported) {
      showCliPrerequisiteWarning(status)
      return status
    }

    if (status.pathConfigured === null) {
      showCliPrerequisiteWarning(status)
      return status
    }

    if (status.state !== 'installed' || status.pathConfigured === false) {
      // Why: macOS may immediately show a native authorization prompt, so the
      // user needs app-level context before that OS dialog appears.
      await showOrcaCliRegistrationPromptToast(registrationPromptDelayMs)
      const next = await window.api.cli.install()
      onStatusChange?.(next)
      showCliPrerequisiteWarning(next)
      return next
    }

    return status
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.lib.agent.skill.cli.prerequisite.8d6eedf97e',
            'Failed to register the Orca CLI in PATH.'
          )
    )
    return null
  }
}

export async function showOrcaCliRegistrationPromptToast(delayMs = 700): Promise<void> {
  toast.message(CLI_PREREQUISITE_REGISTRATION_TOAST, {
    description: CLI_PREREQUISITE_REGISTRATION_TOAST_DESCRIPTION
  })
  await delay(delayMs)
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function showCliPrerequisiteWarning(status: CliInstallStatus): void {
  if (!status.supported) {
    toast.warning(
      translate(
        'auto.lib.agent.skill.cli.prerequisite.2db0bd7515',
        'Orca CLI registration is unavailable'
      ),
      {
        description:
          status.detail ??
          translate(
            'auto.lib.agent.skill.cli.prerequisite.15cbedc3e3',
            'Install the Orca CLI before running agent skill setup.'
          )
      }
    )
    return
  }

  if (status.state !== 'installed') {
    toast.warning(
      translate(
        'auto.lib.agent.skill.cli.prerequisite.e99d7dc36f',
        'Orca CLI registration needs attention'
      ),
      {
        description:
          status.detail ??
          translate(
            'auto.lib.agent.skill.cli.prerequisite.15cbedc3e3',
            'Install the Orca CLI before running agent skill setup.'
          )
      }
    )
    return
  }

  if (status.pathConfigured === null) {
    toast.warning(
      translate(
        'auto.lib.agent.skill.cli.prerequisite.windowsPathUnknown',
        'Orca could not check your Windows user PATH'
      ),
      { description: status.detail ?? 'Refresh CLI registration status and try again.' }
    )
    return
  }

  if (status.pathConfigured === false) {
    // Why: the skill installer opens a real shell; agents only get the expected
    // Orca affordances when that shell can resolve the Orca CLI command.
    toast.warning(
      translate(
        'auto.lib.agent.skill.cli.prerequisite.79371593b0',
        'Orca CLI is not visible on PATH yet'
      ),
      {
        description:
          status.detail ??
          translate(
            'auto.lib.agent.skill.cli.prerequisite.0f116999f1',
            'Restart your shell or add the Orca CLI directory to PATH before setup.'
          )
      }
    )
  }
}
