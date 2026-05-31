const WINDOWS_DRIVE_PATH_PREFIX = /^\/[A-Za-z]:\//
const UNC_PATH_PREFIX = /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/](.*))?$/

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
        return segment
      }
      return encodeURIComponent(segment)
    })
    .join('/')
}

export function filesystemPathToFileUri(filePath: string): string {
  const uncMatch = UNC_PATH_PREFIX.exec(filePath)
  if (uncMatch) {
    const [, host, share, rest = ''] = uncMatch
    const pathSegments = [share, ...rest.replaceAll('\\', '/').split('/').filter(Boolean)]
    // Why: UNC hosts belong in the file URI authority; putting them in the
    // pathname produces file:////server/share and loses the host on decode.
    return `file://${encodeURIComponent(host)}/${pathSegments.map(encodeURIComponent).join('/')}`
  }

  const normalizedPath = filePath.replaceAll('\\', '/')
  const encodedPath = encodePathSegments(normalizedPath)
  return normalizedPath.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`
}

export function fileUriToFilesystemPath(url: URL): string | null {
  if (url.protocol !== 'file:') {
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }

  if (url.hostname && url.hostname !== 'localhost') {
    return `//${url.hostname}${decodedPath}`
  }

  if (WINDOWS_DRIVE_PATH_PREFIX.test(decodedPath)) {
    return decodedPath.slice(1)
  }

  return decodedPath
}
