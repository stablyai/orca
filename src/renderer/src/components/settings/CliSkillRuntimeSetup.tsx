import type { GlobalSettings } from '../../../../shared/types'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  isOrcaCliAvailableOnPath,
  showOrcaCliRegistrationPromptToast
} from '@/lib/agent-skill-cli-prerequisite'
import { Label } from '../ui/label'
import { SettingsSegmentedControl } from './SettingsFormControls'

export type LocalAgentRuntime = {
  runtime: 'host' | 'wsl'
  label: string
}

export function getHostRuntimeLabel(): string {
  return navigator.userAgent.includes('Windows') ? 'Windows' : 'This device'
}

export function getSelectedAgentRuntime(
  settings: GlobalSettings,
  wslSupportedPlatform: boolean,
  wslAvailable: boolean,
  wslCapabilitiesLoading: boolean
): LocalAgentRuntime {
  const selectedRuntime =
    settings.localAgentRuntime ?? (settings.terminalWindowsShell === 'wsl.exe' ? 'wsl' : 'host')
  if (
    wslSupportedPlatform &&
    selectedRuntime === 'wsl' &&
    (wslAvailable || wslCapabilitiesLoading)
  ) {
    return { runtime: 'wsl', label: 'WSL default' }
  }
  return { runtime: 'host', label: getHostRuntimeLabel() }
}

function quotePowerShellSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function buildSkillInstallCommandForRuntime(
  command: string,
  runtime: LocalAgentRuntime
): string {
  return runtime.runtime === 'wsl'
    ? `wsl.exe -- bash -lc ${quotePowerShellSingle(command)}`
    : command
}

export function getAgentSkillTerminalShellOverride(
  currentPlatform: string,
  settings: GlobalSettings,
  runtime: LocalAgentRuntime
): string | undefined {
  if (currentPlatform !== 'win32') {
    return undefined
  }
  if (runtime.runtime === 'wsl') {
    return 'powershell.exe'
  }
  return settings.terminalWindowsShell.toLowerCase() === 'wsl.exe' ? 'powershell.exe' : undefined
}

export async function ensureWslCliAvailableForAgentSkillTerminal(): Promise<CliInstallStatus | null> {
  try {
    const status = await window.api.cli.getWslInstallStatus()
    if (!status.supported) {
      toast.warning('WSL shell command registration is unavailable', {
        description: status.detail ?? 'Register the WSL shell command before skill setup.'
      })
      return status
    }
    if (status.state !== 'installed' || !status.pathConfigured) {
      await showOrcaCliRegistrationPromptToast()
      const next = await window.api.cli.installWsl()
      if (!isOrcaCliAvailableOnPath(next)) {
        toast.warning('WSL shell command needs attention', {
          description: next.detail ?? 'Register the WSL shell command before skill setup.'
        })
      }
      return next
    }
    return status
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : 'Failed to register the WSL shell command.'
    )
    return null
  }
}

type CliSkillRuntimeControlProps = {
  runtime: LocalAgentRuntime
  updateSettings: (updates: Partial<GlobalSettings>) => void
  wslSupportedPlatform: boolean
  wslAvailable: boolean
  wslCapabilitiesLoading: boolean
}

export function CliSkillRuntimeControl({
  runtime,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslCapabilitiesLoading
}: CliSkillRuntimeControlProps): React.JSX.Element | null {
  if (!wslSupportedPlatform) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>Skill location</Label>
        <p className="text-xs text-muted-foreground">
          {runtime.runtime === 'wsl' && !wslAvailable && !wslCapabilitiesLoading
            ? 'WSL is not available on this machine.'
            : 'Choose where Orca checks and installs global agent skills.'}
        </p>
      </div>
      <div className="w-44 shrink-0">
        <SettingsSegmentedControl
          ariaLabel="Skill location"
          value={runtime.runtime}
          onChange={(value) =>
            updateSettings({
              localAgentRuntime: value,
              localAgentWslDistro: null
            })
          }
          equalWidth
          options={[
            { value: 'host', label: getHostRuntimeLabel() },
            {
              value: 'wsl',
              label: 'WSL',
              disabled: wslCapabilitiesLoading || !wslAvailable
            }
          ]}
        />
      </div>
    </div>
  )
}
