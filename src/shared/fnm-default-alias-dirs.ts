import { homedir } from 'node:os'
import { join } from 'node:path'

/** fnm's `default` alias dir. Windows: FNM_DIR, else %APPDATA%\fnm, else legacy ~\.fnm; node.exe has no bin subdir (#11356). */
export function getFnmDefaultAliasDirectories(
  platform: NodeJS.Platform,
  homePath: string,
  appendPath: typeof join = join
): string[] {
  if (platform !== 'win32') {
    return [appendPath(homePath, '.fnm', 'aliases', 'default', 'bin')]
  }
  const fnmDir = process.env.FNM_DIR
  const appData = process.env.APPDATA || appendPath(homePath, 'AppData', 'Roaming')
  const baseDirs = fnmDir ? [fnmDir] : [appendPath(appData, 'fnm'), appendPath(homePath, '.fnm')]
  return baseDirs.map((baseDir) => appendPath(baseDir, 'aliases', 'default'))
}

/** Windows fnm default only backfills a missing node; leading PATH would shadow an inherited system/nvm-windows/`fnm use` Node. */
export function isWindowsFnmDefaultAliasDir(path: string): boolean {
  return (
    process.platform === 'win32' &&
    getFnmDefaultAliasDirectories(process.platform, homedir()).includes(path)
  )
}
