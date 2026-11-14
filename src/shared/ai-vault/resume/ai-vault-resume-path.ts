import { parseWslUncPath, toLinuxPath } from '../../wsl-paths'

export function normalizeAiVaultResumeFilePath(
  filePath: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  if (!filePath || platform !== 'linux') {
    return filePath
  }
  // UNC targets the distro tail; a Windows drive path reaches a symlinked store through drvfs (#42369).
  return parseWslUncPath(filePath)?.linuxPath ?? toLinuxPath(filePath)
}
