import { basename, dirname, joinPath } from '@/lib/path'

export function extractIpcErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) {
    return fallback
  }
  const match = err.message.match(/Error invoking remote method '[^']*': (?:Error: )?(.+)/)
  return match ? match[1] : err.message
}

function splitFileExtension(fileName: string): { stem: string; extension: string } {
  const extensionStart = fileName.lastIndexOf('.')
  if (extensionStart <= 0) {
    return { stem: fileName, extension: '' }
  }
  return {
    stem: fileName.slice(0, extensionStart),
    extension: fileName.slice(extensionStart)
  }
}

export async function getImageCopyDestination(
  markdownFilePath: string,
  sourceImagePath: string
): Promise<{ imageName: string; destPath: string }> {
  const originalImageName = basename(sourceImagePath)
  const markdownDir = dirname(markdownFilePath)
  const { stem, extension } = splitFileExtension(originalImageName)
  let imageName = originalImageName
  let destPath = joinPath(markdownDir, imageName)
  let suffix = 1

  const MAX_DECONFLICT_ATTEMPTS = 1000
  // Why: picking "diagram.png" from elsewhere should not silently replace an
  // existing sibling asset in the note's directory. We deconflict the copy
  // target and keep the inserted markdown pointing at the unique name.
  while (destPath !== sourceImagePath && (await window.api.shell.pathExists(destPath))) {
    if (suffix >= MAX_DECONFLICT_ATTEMPTS) {
      throw new Error(`Too many name collisions for "${originalImageName}".`)
    }
    imageName = `${stem}-${suffix}${extension}`
    destPath = joinPath(markdownDir, imageName)
    suffix += 1
  }

  return { imageName, destPath }
}
