import { deriveCloneRepoNameFromUrl } from '../../../../shared/git-clone-repository-name'

export function getCloneFolderNamePreview(url: string): string | null {
  try {
    return deriveCloneRepoNameFromUrl(url.trim())
  } catch {
    return null
  }
}

export function getClonePathPreview(parent: string, folderName: string | null): string | null {
  const trimmedParent = parent.trim()
  if (!trimmedParent || !folderName) {
    return null
  }
  const separator = trimmedParent.includes('\\') && !trimmedParent.includes('/') ? '\\' : '/'
  const withoutTrailingSeparators = trimmedParent.replace(/[\\/]+$/, '')
  if (!withoutTrailingSeparators) {
    return `${separator}${folderName}`
  }
  return `${withoutTrailingSeparators}${separator}${folderName}`
}
