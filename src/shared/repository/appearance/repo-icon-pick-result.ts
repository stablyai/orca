import type { RepoIconPickFailure } from './repo-icon-pick-failure-copy'

/** A valid PNG at or below the storage cap still persists without any main-side processing. */
export type RepoIconPickDirectResult = {
  kind: 'direct'
  dataUrl: string
  fileName: string
}

/**
 * Large PNGs and every JPEG stay on the main side behind an opaque, sender-scoped token until
 * the renderer explicitly asks for a converted preview.
 */
export type RepoIconPickPendingResult = {
  kind: 'pending'
  token: string
  fileName: string
  originalBytes: number
  originalMimeType: 'image/png' | 'image/jpeg'
}

export type RepoIconPickResult =
  | RepoIconPickDirectResult
  | RepoIconPickPendingResult
  | RepoIconPickFailure
  | null

/** The exact limited PNG shown in the preview; persist this data URL unchanged. */
export type RepoIconPreview = {
  dataUrl: string
  bytes: number
  width: number
  height: number
}

export type RepoIconPreviewResult = RepoIconPreview | RepoIconPickFailure | null

export function isRepoIconPickFailure(
  value: RepoIconPickResult | RepoIconPreviewResult
): value is RepoIconPickFailure {
  return value !== null && 'ok' in value && value.ok === false
}
