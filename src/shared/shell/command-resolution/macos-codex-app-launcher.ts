import { homedir } from 'node:os'
import { posix } from 'node:path'
import { isRunnableCommandAsync } from './cli-fs-reads'

const CODEX_APP_BIN = posix.join('ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin')

export function codexAppBinDirectories(
  platform: NodeJS.Platform = process.platform,
  homePath: string = homedir()
): string[] {
  return platform === 'darwin'
    ? [
        posix.join(homePath, 'Applications', CODEX_APP_BIN),
        posix.join('/Applications', CODEX_APP_BIN)
      ]
    : []
}

/** Preserve a launcher that the user already added to PATH ahead of Orca's managed copy. */
export function isCodexAppFallback(command: string, pathEnv?: string | null): boolean {
  return (
    command.endsWith(`/${posix.join(CODEX_APP_BIN, 'codex')}`) &&
    !(pathEnv ?? process.env.PATH ?? process.env.Path ?? '')
      .split(posix.delimiter)
      .some((entry) => posix.join(entry.trim(), 'codex') === command)
  )
}

export async function findCodexAppBinDirectory(
  platform: NodeJS.Platform,
  homePath?: string
): Promise<string | null> {
  for (const directory of codexAppBinDirectories(platform, homePath)) {
    if (await isRunnableCommandAsync(platform, posix.join(directory, 'codex'))) {
      return directory
    }
  }
  return null
}
