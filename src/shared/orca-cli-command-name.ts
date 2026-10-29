import { getAppEnvironment, hasAppEnvironment } from './app-environment'

export function getOrcaCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'orca-ide'
  }
  if (platform === 'win32') {
    return 'orca.cmd'
  }
  return 'orca'
}

/** The GNOME-conflict `orca-ide` rename is desktop-only: SSH relays and headless Orca servers put plain `orca` on PATH. */
export function skipsLinuxOrcaCliRename(isRemote: boolean | undefined): boolean {
  if (isRemote) {
    return true
  }
  // Only a headless server publishes its own launcher; Windows ones (WSL launches) keep the rename.
  const launcher = hasAppEnvironment() ? getAppEnvironment().getCliLauncherPath?.() : null
  return launcher?.endsWith('/orca') ?? false
}
