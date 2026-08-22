import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type CodexDesktopBinPathOptions = {
  homePath?: string
  localAppDataPath?: string
  platform?: NodeJS.Platform
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll('/', '\\').toLowerCase()
}

export function isPrivateCodexMsixResourcePath(candidate: string): boolean {
  return /(?:^|\\)windowsapps\\openai\.codex_[^\\]+\\app\\resources(?:\\|$)/i.test(
    normalizeWindowsPath(candidate)
  )
}

export function isPrivateCodexMsixCliPath(candidate: string): boolean {
  return (
    isPrivateCodexMsixResourcePath(candidate) &&
    /\\codex(?:\.exe)?$/i.test(normalizeWindowsPath(candidate))
  )
}

export function getCodexDesktopBinPaths(options: CodexDesktopBinPathOptions = {}): string[] {
  if ((options.platform ?? process.platform) !== 'win32') {
    return []
  }

  const homePath = options.homePath ?? homedir()
  const localAppDataPath =
    options.localAppDataPath ??
    (options.homePath === undefined ? process.env.LOCALAPPDATA : undefined) ??
    join(homePath, 'AppData', 'Local')
  const root = join(localAppDataPath, 'OpenAI', 'Codex', 'bin')

  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          const directory = join(root, entry.name)
          const stats = statSync(join(directory, 'codex.exe'))
          return stats.isFile() ? { directory, modifiedAt: stats.mtimeMs } : null
        } catch {
          return null
        }
      })
      .filter((entry): entry is { directory: string; modifiedAt: number } => entry !== null)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .map(({ directory }) => directory)
  } catch {
    return []
  }
}
