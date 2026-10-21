import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeAppBackgroundBlur,
  normalizeAppBackgroundImageId,
  normalizeAppBackgroundImageOpacity,
  normalizeAppBackgroundPanelOpacity,
  normalizeAppBackgroundScope,
  type AppBackgroundScope
} from '../../../../shared/app-background-settings'

/** Numeric/scope fields the background settings draft edits before Apply. */
export type AppBackgroundDraftValues = {
  scope: AppBackgroundScope
  imageOpacity: number
  blur: number
  panelOpacity: number
  terminalBackgroundOpacity: number
}

export type AppBackgroundDraftImage =
  | { kind: 'unchanged' }
  | { kind: 'staged'; stagingId: string }
  | { kind: 'remove' }

/** Session-only background settings draft (same lifetime model as feedback-draft):
 *  it survives leaving the settings page and is cleared by Apply, Discard or restart.
 *  Blob URLs never live here; see app-background-blob-cache. */
export type AppBackgroundDraft = AppBackgroundDraftValues & {
  image: AppBackgroundDraftImage
  /** Applied settings the draft is compared against; rebased whenever settings change. */
  snapshot: AppBackgroundDraftValues & { imageId: string | null }
}

export function readAppBackgroundDraftValues(
  settings: GlobalSettings | null
): AppBackgroundDraftValues {
  return {
    scope: normalizeAppBackgroundScope(settings?.appBackgroundScope),
    imageOpacity: normalizeAppBackgroundImageOpacity(settings?.appBackgroundImageOpacity),
    blur: normalizeAppBackgroundBlur(settings?.appBackgroundBlur),
    panelOpacity: normalizeAppBackgroundPanelOpacity(settings?.appBackgroundPanelOpacity),
    terminalBackgroundOpacity: normalizeTerminalBackgroundOpacity(
      settings?.terminalBackgroundOpacity
    )
  }
}

export function normalizeTerminalBackgroundOpacity(value: unknown): number {
  // Why: undefined means "opaque" everywhere terminalBackgroundOpacity is read.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1
  }
  return Math.min(1, Math.max(0, value))
}

/** The snapshot always mirrors current settings, so "changed" means "differs from what is applied now". */
export function rebaseAppBackgroundDraft(
  draft: AppBackgroundDraft,
  settings: GlobalSettings | null
): AppBackgroundDraft {
  const next = readAppBackgroundDraftValues(settings)
  const nextImageId = normalizeAppBackgroundImageId(settings?.appBackgroundImageId)
  const { snapshot } = draft
  if (
    snapshot.imageId === nextImageId &&
    snapshot.scope === next.scope &&
    snapshot.imageOpacity === next.imageOpacity &&
    snapshot.blur === next.blur &&
    snapshot.panelOpacity === next.panelOpacity &&
    snapshot.terminalBackgroundOpacity === next.terminalBackgroundOpacity
  ) {
    return draft
  }
  const edited: AppBackgroundDraftValues = draft
  const baseline: AppBackgroundDraftValues = snapshot
  const follow = <K extends keyof AppBackgroundDraftValues>(key: K): AppBackgroundDraftValues[K] =>
    edited[key] === baseline[key] ? next[key] : edited[key]
  return {
    scope: follow('scope'),
    imageOpacity: follow('imageOpacity'),
    blur: follow('blur'),
    panelOpacity: follow('panelOpacity'),
    terminalBackgroundOpacity: follow('terminalBackgroundOpacity'),
    image:
      draft.image.kind === 'remove' && nextImageId === null ? { kind: 'unchanged' } : draft.image,
    snapshot: { ...next, imageId: nextImageId }
  }
}
