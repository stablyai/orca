import { homedir } from 'node:os'
import { join } from 'node:path'

/** fnm's `default` alias dir. Windows: FNM_DIR, else %APPDATA%\fnm, else legacy ~\.fnm; node.exe has no bin subdir (#11356). */
export function getFnmDefaultAliasDirectories(
  platform: NodeJS.Platform,
  homePath: string
): string[] {
  if (platform !== 'win32') {
    return [join(homePath, '.fnm', 'aliases', 'default', 'bin')]
  }
  const fnmDir = process.env.FNM_DIR
  const appData = process.env.APPDATA || join(homePath, 'AppData', 'Roaming')
  const baseDirs = fnmDir ? [fnmDir] : [join(appData, 'fnm'), join(homePath, '.fnm')]
  return baseDirs.map((baseDir) => join(baseDir, 'aliases', 'default'))
}

/** Windows fnm default only backfills a missing node; leading PATH would shadow an inherited system/nvm-windows/`fnm use` Node. */
export function isWindowsFnmDefaultAliasDir(path: string): boolean {
  return (
    process.platform === 'win32' &&
    getFnmDefaultAliasDirectories(process.platform, homedir()).includes(path)
  )
}
