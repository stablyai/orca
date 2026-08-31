import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { IMAGE_FILE_EXTENSIONS } from '../../../../shared/image-file-extensions'

export const MAX_AUTOMATIC_DIFF_CHANGED_LINES = 10_000

// SVG is excluded: it reads as text, so the diff view renders its source in Monaco
// rather than an image preview — deferral is exactly what an oversized one needs.
const PREVIEWED_IMAGE_EXTENSIONS = IMAGE_FILE_EXTENSIONS.filter((ext) => ext !== '.svg')

function isPreviewedImagePath(path: string | undefined): boolean {
  const lowerPath = path?.toLowerCase()
  return (
    lowerPath !== undefined && PREVIEWED_IMAGE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))
  )
}

export function shouldLoadCombinedDiffOnDemand({
  added,
  removed,
  area,
  path
}: {
  added?: number
  removed?: number
  area?: GitStatusEntry['area']
  path?: string
}): boolean {
  if (added === undefined && removed === undefined) {
    // Untracked files lose their counts once they exceed the status-scan size cap
    // (MAX_UNTRACKED_LINE_COUNT_BYTES), so an uncounted untracked file is either
    // oversized text or binary — both too costly to auto-load. Images stay automatic
    // because their preview is the point of the row.
    return area === 'untracked' && !isPreviewedImagePath(path)
  }
  return (added ?? 0) + (removed ?? 0) > MAX_AUTOMATIC_DIFF_CHANGED_LINES
}
