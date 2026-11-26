import { parseWslUncPath } from '../../file-access/wsl-paths'

export function normalizeAiVaultResumeFilePath(
  filePath: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  if (!filePath || platform !== 'linux') {
    return filePath
  }
  return parseWslUncPath(filePath)?.linuxPath ?? filePath
}

export function getAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  // Translate WSL UNC Codex homes to POSIX only for Linux targets.
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}
