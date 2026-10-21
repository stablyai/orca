import { fileUriToFilesystemPath } from './file-uri-path'

export function isHtmlFilePath(filePath: string): boolean {
  return /\.html?$/i.test(filePath)
}

/** File authorities name this machine, never an Orca SSH target. */
export function htmlFilePathFromUrl(input: string): string | null {
  if (!/^file:\/\//i.test(input) || /[?#\p{Cc}]|%2f|%5c/iu.test(input)) {
    return null
  }
  try {
    const url = new URL(input)
    if (url.hostname || url.pathname.startsWith('//')) {
      return null
    }
    const filePath = fileUriToFilesystemPath(url)
    return filePath && isHtmlFilePath(filePath) && !/\p{Cc}/u.test(filePath) ? filePath : null
  } catch {
    return null
  }
}
