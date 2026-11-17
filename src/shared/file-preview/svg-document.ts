export type SvgIntrinsicSize = { width: number; height: number }

// CSS absolute units in px; percentages and font-relative units have no size outside a page.
const ABSOLUTE_UNIT_PX: Record<string, number> = {
  '': 1,
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6
}

export function isSvgFilePath(filePath: string): boolean {
  return /\.svg$/i.test(filePath)
}

function readAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? null) : null
}

function readLength(value: string | null): number | null {
  const match = value?.trim().match(/^([+]?\d*\.?\d+(?:e[+-]?\d+)?)\s*([a-z]*)$/i)
  const unit = match ? ABSOLUTE_UNIT_PX[match[2].toLowerCase()] : undefined
  const length = match && unit !== undefined ? Number(match[1]) * unit : Number.NaN
  return length > 0 ? length : null
}

function readViewBox(value: string | null): SvgIntrinsicSize | null {
  const [, , width, height] = (value ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return width > 0 && height > 0 ? { width, height } : null
}

/**
 * The size an SVG draws at 100%: absolute `width`/`height`, a missing one derived from the
 * `viewBox` ratio, else the `viewBox` itself. Browsers report 300×150-style defaults instead.
 */
export function readSvgIntrinsicSize(markup: string): SvgIntrinsicSize | null {
  const tag = /<svg\b[^>]*>/i.exec(markup)?.[0]
  if (!tag) {
    return null
  }
  const width = readLength(readAttribute(tag, 'width'))
  const height = readLength(readAttribute(tag, 'height'))
  if (width !== null && height !== null) {
    return { width, height }
  }
  const viewBox = readViewBox(readAttribute(tag, 'viewBox'))
  if (!viewBox) {
    return null
  }
  if (width !== null) {
    return { width, height: (width * viewBox.height) / viewBox.width }
  }
  if (height !== null) {
    return { width: (height * viewBox.width) / viewBox.height, height }
  }
  return viewBox
}

/** UTF-8 SVG markup from base64 bytes; null when they are not text, such as gzipped `.svgz` data. */
export function decodeSvgBase64(base64: string): string | null {
  try {
    const binary = atob(base64.replace(/\s/g, ''))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

/** An `<img>` source for SVG markup; images never run the document's scripts or fetch its references. */
export function svgMarkupDataUri(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
}
