/**
 * xterm shares one glyph atlas per font/colour config and never rechecks the page pixels behind a cache
 * entry, and reveal keeps the atlas. If a page loses its pixels (an unconfirmed hypothesis for STA-17523),
 * every renderer that uploads it draws blanks. Sample glyph rects that provably held ink and evict the atlas
 * when one reads blank. This does not detect glyphs cached empty or stale per-renderer GPU textures.
 */

export type GlyphRect = { x: number; y: number; width: number; height: number }

type AtlasGlyph = {
  texturePosition?: { x: number; y: number }
  size?: { x: number; y: number }
  offset?: { x: number; y: number }
}

export type AtlasCanvas = { width: number; height: number }

type AtlasPageLike = {
  canvas?: AtlasCanvas
  glyphs?: readonly AtlasGlyph[]
}

export type GlyphAtlasLike = {
  readonly pages: readonly AtlasPageLike[]
  readonly pageLayoutVersion?: number
}

/** `unavailable`: no read was issued (scratch setup failed); `unreadable`: an issued read was invalid. */
export type InkRead = 'ink' | 'blank' | 'unreadable' | 'unavailable'
export type GlyphInkReader = (canvas: AtlasCanvas, rect: GlyphRect) => InkRead

export type AtlasPoisonFinding = { reason: 'blank-page-glyph'; page: number; pageSize: number }

export type AtlasCheckResult =
  | { outcome: 'poisoned'; finding: AtlasPoisonFinding; reads: number }
  | { outcome: 'healthy' | 'inconclusive'; reads: number }

export const MAX_RECT_SIZE = 256
const MAX_VISITS_PER_PAGE = 64
const MAX_VISITS_PER_ATTEMPT = 1024

/**
 * xterm sets offset.y = padding - top + adj (padding 4, or 0 for restricted glyphs; adj >= 0), and a missed
 * top scan leaves top = 0. So offset.y <= -1 means the scan found an inked pixel, which lies inside the crop
 * xterm packs; an intact page therefore shows ink in this rect. Other glyphs are not evidence either way.
 */
export function admittedRect(glyph: AtlasGlyph, canvas: AtlasCanvas): GlyphRect | null {
  const { texturePosition: position, size, offset } = glyph
  if (!position || !size || !offset || !(offset.y <= -1)) {
    return null
  }
  const rect = { x: position.x, y: position.y, width: size.x, height: size.y }
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 1 ||
    rect.height < 1 ||
    rect.width > MAX_RECT_SIZE ||
    rect.height > MAX_RECT_SIZE ||
    rect.x + rect.width > canvas.width ||
    rect.y + rect.height > canvas.height
  ) {
    return null
  }
  return rect
}

/** Per atlas and page: where the next scan starts, past the last read entry, so admitted glyphs are read in turn. */
export type Traversal = { layoutVersion: number | undefined; cursors: number[]; startPage: number }

function nextReadCandidate(
  glyphs: readonly AtlasGlyph[],
  canvas: AtlasCanvas,
  start: number,
  scans: number
): { rect: GlyphRect | null; next: number } {
  for (let i = 0; i < scans; i++) {
    const rect = admittedRect(glyphs[(start + i) % glyphs.length], canvas)
    if (rect) {
      return { rect, next: start + i + 1 }
    }
  }
  return { rect: null, next: start + scans }
}

/**
 * One read per page per attempt. A valid blank is acted on even after an earlier invalid read; a second invalid
 * read or an unavailable scratch ends sampling. Healthy only when every selected read was a valid ink.
 */
export function checkAtlasIntegrity(
  atlas: GlyphAtlasLike,
  read: GlyphInkReader,
  traversal: Traversal,
  maxReads: number
): AtlasCheckResult {
  if (traversal.layoutVersion !== atlas.pageLayoutVersion) {
    traversal.layoutVersion = atlas.pageLayoutVersion
    traversal.cursors = []
  }
  let reads = 0
  let inked = 0
  let invalid = 0
  let unavailable = false
  let scansLeft = MAX_VISITS_PER_ATTEMPT
  const pageCount = atlas.pages.length
  const firstPage = pageCount ? traversal.startPage % pageCount : 0
  traversal.startPage = firstPage + 1
  for (let step = 0; step < pageCount && scansLeft > 0 && reads < maxReads; step++) {
    const page = (firstPage + step) % pageCount
    const { canvas, glyphs } = atlas.pages[page]
    if (!canvas?.width || !canvas.height || !glyphs?.length) {
      continue
    }
    const scans = Math.min(glyphs.length, MAX_VISITS_PER_PAGE, scansLeft)
    const start = (traversal.cursors[page] ?? 0) % glyphs.length
    const candidate = nextReadCandidate(glyphs, canvas, start, scans)
    traversal.cursors[page] = candidate.next
    scansLeft -= scans
    if (!candidate.rect) {
      continue
    }
    let result: InkRead
    try {
      result = read(canvas, candidate.rect)
    } catch {
      result = 'unreadable'
    }
    if (result === 'unavailable') {
      unavailable = true
      break
    }
    reads++
    if (result === 'blank') {
      return {
        outcome: 'poisoned',
        finding: { reason: 'blank-page-glyph', page, pageSize: canvas.width },
        reads
      }
    }
    if (result === 'ink') {
      inked++
    } else if (++invalid >= 2) {
      break
    }
  }
  const healthy = inked > 0 && inked === reads && invalid === 0 && !unavailable
  return { outcome: healthy ? 'healthy' : 'inconclusive', reads }
}
