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

export function filesystemPathHrefToFileUri(filePathHref: string): string {
  const suffixIndex = filePathHref.search(/[?#]/)
  if (suffixIndex === -1) {
    return filesystemPathToFileUri(filePathHref)
  }

  const pathPart = filePathHref.slice(0, suffixIndex)
  const suffix = filePathHref.slice(suffixIndex)
  const url = new URL(filesystemPathToFileUri(pathPart))
  if (suffix.startsWith('#')) {
    // Why: markdown href fragments like `#L10` should stay URL fragments,
    // not become `%23L10` inside the Windows filesystem path.
    url.hash = suffix
    return url.toString()
  }

  const hashIndex = suffix.indexOf('#')
  url.search = hashIndex === -1 ? suffix : suffix.slice(0, hashIndex)
  if (hashIndex !== -1) {
    url.hash = suffix.slice(hashIndex)
  }
  return url.toString()
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
