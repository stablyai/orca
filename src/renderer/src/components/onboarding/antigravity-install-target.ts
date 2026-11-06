// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import type { LocalPreflightContext } from '@/lib/local-preflight-context'
import { translate } from '@/i18n/i18n'
import { getHostRuntimeLabel, type LocalAgentRuntime } from '@/lib/skill-runtime-command'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../../shared/ephemeral-setup-terminal-worktree-id'

export const ANTIGRAVITY_INSTALL_TERMINAL_WORKTREE_ID = brandEphemeralSetupTerminalWorktreeId(
  'onboarding-antigravity-install'
)

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
  if (platform !== 'win32') {
    return { platform, command: POSIX_INSTALL_COMMAND, runtime: { runtime: 'host', label: '' } }
  }
  return {
    platform,
    command: distro ? POSIX_INSTALL_COMMAND : POWERSHELL_INSTALL_COMMAND,
    shellOverride: 'powershell.exe',
    runtime: distro
      ? {
          runtime: 'wsl',
          wslDistro: distro,
          label: translate('components.onboarding.agyInstall.wslLocation', 'WSL {{distro}}', {
            distro
          })
        }
      : { runtime: 'host', label: getHostRuntimeLabel() }
  }
}
