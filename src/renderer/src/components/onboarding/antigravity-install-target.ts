import type { LocalPreflightContext } from '@/lib/local-preflight-context'
import type { LocalAgentRuntime } from '../settings/CliSkillRuntimeSetup'

export type AntigravityInstallTarget = {
  platform: NodeJS.Platform
  command: string
  shellOverride: string
  runtime: LocalAgentRuntime
}

export function resolveAntigravityInstallTarget(
  platform: NodeJS.Platform,
  context: LocalPreflightContext,
  hasLocalTerminalAuthority: boolean
): AntigravityInstallTarget | null {
  if (!hasLocalTerminalAuthority || context?.projectRuntime?.status === 'repair-required') {
    return null
  }
  const projectRuntime = context?.projectRuntime
  const distro =
    projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl'
      ? projectRuntime.runtime.distro
      : context?.wslDistro
  const wsl = Boolean(distro || context?.wslDefault)
  if (wsl && platform !== 'win32') {
    return null
  }
  return {
    platform,
    command:
      platform === 'win32' && !wsl
        ? 'irm https://antigravity.google/cli/install.ps1 | iex'
        : 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    shellOverride: platform === 'win32' ? 'powershell.exe' : '/bin/bash',
    runtime: wsl
      ? { runtime: 'wsl', wslDistro: distro, label: distro ? `WSL ${distro}` : 'WSL' }
      : { runtime: 'host', label: platform === 'win32' ? 'Windows' : '' }
  }
}
