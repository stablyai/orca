/**
 * Which Office formats Orca renders, and which it only recognises.
 *
 * One table, consulted by the routing plan, the preview surface and the host-side
 * service alike. The distinction it encodes matters more than it looks: a format we
 * cannot render must say so itself, never blame a missing `officecli`.
 */

/**
 * Renderable by `officecli view <f> html`.
 *
 * Macro-enabled formats are in this list on purpose. Verified against officecli
 * 1.0.148 on macOS: `view … html` renders a genuine `.docm` (macro content type,
 * `vbaProject.bin` part and relationship) byte-for-byte like its `.docx` twin, and
 * the tool's own unsupported-type message names `.docm`/`.xlsm`/`.pptm` as
 * supported. Only `create` refuses them, and Orca never calls `create`.
 * Re-verify when the pinned version moves.
 */
export const OFFICE_RENDERABLE_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.pptx',
  '.docm',
  '.xlsm',
  '.pptm'
] as const

/** Recognised as Office documents, refused by the renderer: legacy binaries and ODF. */
export const OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS = [
  '.doc',
  '.xls',
  '.ppt',
  '.odt',
  '.ods',
  '.odp'
] as const

export type OfficeRenderableExtension = (typeof OFFICE_RENDERABLE_EXTENSIONS)[number]
export type OfficeUnrenderableExtension = (typeof OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS)[number]

/** Which of the three renderers a document belongs to; drives icons, labels and selection support. */
export type OfficeDocKind = 'word' | 'excel' | 'ppt'

const KIND_BY_EXTENSION: Record<string, OfficeDocKind> = {
  '.docx': 'word',
  '.docm': 'word',
  '.doc': 'word',
  '.odt': 'word',
  '.xlsx': 'excel',
  '.xlsm': 'excel',
  '.xls': 'excel',
  '.ods': 'excel',
  '.pptx': 'ppt',
  '.pptm': 'ppt',
  '.ppt': 'ppt',
  '.odp': 'ppt'
}

const RENDERABLE = new Set<string>(OFFICE_RENDERABLE_EXTENSIONS)
const IDENTIFIED_UNRENDERABLE = new Set<string>(OFFICE_IDENTIFIED_UNRENDERABLE_EXTENSIONS)

/** Lowercased extension including the dot, or `''`. Deliberately not `path.extname`: this runs in
 *  the renderer too, and a Windows path reaching a posix build must still split on `\`. */
export function officeFileExtension(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

export function officeDocKind(filePath: string): OfficeDocKind | null {
  return KIND_BY_EXTENSION[officeFileExtension(filePath)] ?? null
}

export function isOfficeRenderable(filePath: string): boolean {
  return RENDERABLE.has(officeFileExtension(filePath))
}

export function isIdentifiedUnrenderableOffice(filePath: string): boolean {
  return IDENTIFIED_UNRENDERABLE.has(officeFileExtension(filePath))
}

/** Any file this feature recognises at all, renderable or not. */
export function isOfficeDocument(filePath: string): boolean {
  return isOfficeRenderable(filePath) || isIdentifiedUnrenderableOffice(filePath)
}

/** Reader-facing format name for the unrenderable panel. Codes cross process boundaries; this
 *  names a file format, which is the same word in every locale we ship. */
export const OFFICE_FORMAT_LABELS: Record<OfficeUnrenderableExtension, string> = {
  '.doc': 'Word 97–2003',
  '.xls': 'Excel 97–2003',
  '.ppt': 'PowerPoint 97–2003',
  '.odt': 'OpenDocument Text',
  '.ods': 'OpenDocument Spreadsheet',
  '.odp': 'OpenDocument Presentation'
}

/**
 * `.xlsx` has no addressable element paths, so `officecli get <f> selected` cannot answer for it.
 * Phase 3's selection control reads this rather than discovering the emptiness at click time.
 */
export function officeKindSupportsSelection(kind: OfficeDocKind): boolean {
  return kind !== 'excel'
}
