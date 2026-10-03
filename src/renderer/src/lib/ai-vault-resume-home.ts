import { parseWslUncPath } from '../../../shared/wsl-paths'

export function getAiVaultResumeAccountHome(
  home: string | null,
  platform: NodeJS.Platform
): string | null {
  // WSL account homes must be POSIX when invoking Linux commands.
  if (!home || platform !== 'linux') {
    return home
  }
  return parseWslUncPath(home)?.linuxPath ?? home
}
