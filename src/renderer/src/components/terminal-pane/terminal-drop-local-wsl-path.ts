import { parseWslUncPath } from '../../../../shared/wsl-paths'

export function toLocalWslDropPath(path: string): string {
  const wslUnc = parseWslUncPath(path)
  if (wslUnc) {
    return wslUnc.linuxPath
  }
  if (/^[A-Za-z]:[\\/]/u.test(path)) {
    const drive = path[0].toLowerCase()
    return `/mnt/${drive}/${path.slice(3).replace(/\\/g, '/')}`
  }
  return path.replace(/\\/g, '/')
}
