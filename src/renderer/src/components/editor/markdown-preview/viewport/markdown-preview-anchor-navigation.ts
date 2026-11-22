import { elementScroll, type Virtualizer } from '@tanstack/react-virtual'
import type { ProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import { MARKDOWN_PREVIEW_HTML_ID_PREFIX } from '../render-tree/markdown-preview-plugins'

export function getMarkdownPreviewAnchorScrollTop(
  container: Pick<HTMLElement, 'getBoundingClientRect' | 'scrollTop'>,
  target: Pick<HTMLElement, 'getBoundingClientRect'>,
  align: 'start' | 'center' = 'start'
): number {
  const viewport = container.getBoundingClientRect()
  const bounds = target.getBoundingClientRect()
  const offset = align === 'center' ? (viewport.height - bounds.height) / 2 : 12
  return Math.max(0, bounds.top - viewport.top + container.scrollTop - offset)
}

function decodeMarkdownPreviewAnchor(rawAnchor: string): string {
  try {
    return decodeURIComponent(rawAnchor)
  } catch {
    return rawAnchor
  }
}

export function resolveMarkdownPreviewAnchorId(
  rawAnchor: string,
  hasId: (id: string) => boolean
): string | null {
  const decoded = decodeMarkdownPreviewAnchor(rawAnchor)
  if (!decoded) {
    return null
  }
  if (hasId(decoded)) {
    return decoded
  }
  // The sanitizer always adds one prefix, including when the authored id already has it.
  const prefixed = `${MARKDOWN_PREVIEW_HTML_ID_PREFIX}${decoded}`
  return hasId(prefixed) ? prefixed : null
}

export function findMarkdownPreviewAnchorElement(
  root: ParentNode,
  rawAnchor: string
): HTMLElement | null {
  const decoded = decodeMarkdownPreviewAnchor(rawAnchor)
  if (!decoded) {
    return null
  }
  const prefixed = `${MARKDOWN_PREVIEW_HTML_ID_PREFIX}${decoded}`
  // Why: exact ids (heading slugs) win over the sanitizer-prefixed id, so stop at the first exact match.
  let prefixedMatch: HTMLElement | null = null
  for (const node of root.querySelectorAll<HTMLElement>('[id]')) {
    const { id } = node
    if (id === decoded) {
      return node
    }
    if (prefixedMatch === null && id === prefixed) {
      prefixedMatch = node
    }
  }
  return prefixedMatch
}

export function scrollMarkdownPreviewVirtualizer(
  offset: number,
  options: { adjustments?: number; behavior?: ScrollBehavior },
  instance: Virtualizer<HTMLDivElement, HTMLDivElement>,
  marks: ProgrammaticScrollMarks
): void {
  const element = instance.scrollElement
  const previous = element?.scrollTop
  elementScroll(offset, options, instance)
  const landing = element?.scrollTop
  if (landing !== undefined && landing !== previous) {
    marks.mark(landing)
  }
}

export function scrollMarkdownPreviewTo(
  container: HTMLDivElement,
  top: number,
  marks: ProgrammaticScrollMarks
): void {
  const previous = container.scrollTop
  container.scrollTo({ top })
  if (container.scrollTop !== previous) {
    marks.mark(container.scrollTop)
  }
}
