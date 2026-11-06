// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import type { LocalPreflightContext } from '@/lib/local-preflight-context'
import type { LocalAgentRuntime } from '@/lib/skill-runtime-command'

// Official commands from https://antigravity.google/docs/getting-started?tab=cli
const POSIX_INSTALL_COMMAND = 'curl -fsSL https://antigravity.google/cli/install.sh | bash'
const POWERSHELL_INSTALL_COMMAND = 'irm https://antigravity.google/cli/install.ps1 | iex'

export type AntigravityInstallTarget = {
  platform: NodeJS.Platform
  command: string
  /** PowerShell on Windows (native, or to reach WSL); POSIX hosts keep the user's own shell. */
  shellOverride?: string
  runtime: LocalAgentRuntime
}

/** Install where onboarding detects agents, or nowhere when that host isn't this computer. */
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
  const wsl = platform === 'win32' && Boolean(distro || context?.wslDefault)
  if (platform !== 'win32') {
    return { platform, command: POSIX_INSTALL_COMMAND, runtime: { runtime: 'host', label: '' } }
  }
  return {
    platform,
    command: wsl ? POSIX_INSTALL_COMMAND : POWERSHELL_INSTALL_COMMAND,
    shellOverride: 'powershell.exe',
    runtime: wsl
      ? { runtime: 'wsl', wslDistro: distro ?? null, label: distro ? `WSL ${distro}` : 'WSL' }
      : { runtime: 'host', label: 'Windows' }
  }
}
