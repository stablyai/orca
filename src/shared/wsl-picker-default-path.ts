import { normalizeGlobalWindowsRuntimeDefault } from './project-execution-runtime'

/**
 * Distro whose filesystem the folder picker should open in, or null when the
 * OS default location is correct (non-Windows, Windows-host default, or a WSL
 * default that has not selected a concrete distro yet).
 *
 * Why: when WSL is the default project runtime, "add project" should browse the
 * distro's Linux filesystem instead of stranding the user on C:\ with no hint
 * that they can reach WSL folders at all.
 */
export function getWslPickerDefaultDistro(
  runtimeDefault: unknown,
  platform: string
): string | null {
  if (platform !== 'win32') {
    return null
  }
  const normalized = normalizeGlobalWindowsRuntimeDefault(runtimeDefault)
  return normalized.kind === 'wsl' && normalized.distro ? normalized.distro : null
}

/**
 * UNC path to seed the native folder dialog's `defaultPath` with. Prefers the
 * distro's resolved $HOME; falls back to the distro root when $HOME can't be
 * resolved so the picker still lands inside WSL rather than on the Windows host.
 */
export function buildWslPickerDefaultPath(distro: string, wslHomeUncPath: string | null): string {
  return wslHomeUncPath ?? `\\\\wsl.localhost\\${distro}`
}
