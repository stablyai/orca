export type WslUncPathInfo = {
  distro: string
  linuxPath: string
}

export function parseWslUncPath(path: string): WslUncPathInfo | null {
  const normalized = path.replace(/\\/g, '/')
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (!match) {
    return null
  }

  return {
    distro: match[2],
    linuxPath: match[3] || '/'
  }
}

export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}
