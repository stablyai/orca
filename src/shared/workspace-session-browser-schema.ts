/* Why: the browser slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget; the
 * schemas themselves are unchanged apart from the per-entry tolerance the
 * session schema now declares everywhere. */
import { z } from 'zod'
import type { BrowserWorkspace } from './browser-workspace-types'
import { normalizeBrowserHistoryEntries } from './workspace-session-browser-history'
import { normalizeWorkspaceDocHistoryEntries } from './workspace-doc-history'
import { isDocPreviewUrl } from './doc-preview-scheme'
import { salvagingArray } from './zod-salvage'

const browserLoadErrorSchema = z.object({
  code: z.number(),
  description: z.string(),
  validatedUrl: z.string()
})

/**
 * Why persisted at all: this is the page's identity. A restored page re-reads the document off
 * today's owners and mints a fresh grant for it, and the grant it had before the restart is
 * deliberately not written anywhere — see `BrowserPageDocLocation`.
 */
const browserPageDocLocationSchema = z.object({
  kind: z.literal('workspace-doc'),
  worktreeId: z.string(),
  filePath: z.string()
})

const browserViewportPresetIdSchema = z.enum([
  'mobile-s',
  'mobile-m',
  'mobile-l',
  'tablet',
  'laptop',
  'laptop-l',
  'desktop'
])

// Why: the z.ZodType<BrowserWorkspace> cast only aligns the static type — it
// does NOT let new fields survive parsing. z.object strips unknown keys, so
// every additive field must be listed below (optional+nullable) or it is
// dropped on restore.
export const browserWorkspaceSchema: z.ZodType<BrowserWorkspace> = z.object({
  id: z.string(),
  worktreeId: z.string(),
  label: z.string().optional(),
  sessionProfileId: z.string().nullable().optional(),
  // Why: optional+nullable so pre-field sessions still validate; without this
  // zod strips the persisted partition on restore, and an isolated tab whose
  // profile mirror is stale at startup would silently fall back to the shared
  // default partition — reopening the storage leak (#6923) across restarts.
  sessionPartition: z.string().nullable().optional(),
  activePageId: z.string().nullable().optional(),
  pageIds: z.array(z.string()).optional(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  faviconUrl: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: z.number(),
  docLocation: browserPageDocLocationSchema.nullable().optional()
})

const browserPageConversionOriginSchema = z
  .union([
    z.object({ kind: z.literal('workspace-doc'), docLocation: browserPageDocLocationSchema }),
    z.object({
      kind: z.literal('url'),
      url: z.string(),
      browserRuntimeEnvironmentId: z.string().nullable().optional()
    })
  ])
  .nullable()
  .optional()
  .transform((origin) =>
    origin && origin.kind === 'url' && isDocPreviewUrl(origin.url) ? null : origin
  )

export const browserPageSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  worktreeId: z.string(),
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  faviconUrl: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loadError: browserLoadErrorSchema.nullable(),
  createdAt: z.number(),
  // Why: explicit null marks a browser page as client-local even when its
  // worktree is remote-owned; older sessions omit it and keep inferred runtime.
  browserRuntimeEnvironmentId: z.string().nullable().optional(),
  // Why: the pair the relaunched client rebuilds the remote page handle from. Optional so older
  // sessions still validate; stripping either half restores the page as a fresh server tab.
  remoteBrowserPageId: z.string().nullable().optional(),
  remoteBrowserPageClientHosted: z.boolean().optional(),
  // Why: optional+nullable so sessions persisted before viewport presets were
  // added still validate; without this, zod would strip the field during
  // restore and reset the user's chosen preset on every app restart.
  viewportPresetId: browserViewportPresetIdSchema.nullable().optional(),
  // Why listed here and not just typed: z.object strips what it does not name, so an unlisted
  // docLocation restores a workspace document as a blank New Tab — the page keeps its blank url
  // and loses the only field that said which document it was.
  docLocation: browserPageDocLocationSchema.nullable().optional(),
  // Why persisted: one-level history across an address-bar conversion should survive a restart.
  // The url variant holds a store url that already passed every fence on its way in — and the
  // same prefix fence every other url sink applies stands at this door too, so a session file
  // carrying the preview scheme sheds the provenance rather than handing it back to history.
  convertedFrom: browserPageConversionOriginSchema,
  convertedTo: browserPageConversionOriginSchema
})

const browserHistoryEntrySchema = z.object({
  url: z.string(),
  normalizedUrl: z.string(),
  title: z.string(),
  faviconUrl: z.string().nullable().optional(),
  lastVisitedAt: z.number(),
  visitCount: z.number()
})

export const browserHistoryEntriesSchema = salvagingArray(browserHistoryEntrySchema).transform(
  (entries) => normalizeBrowserHistoryEntries(entries)
)

// A document identity and nothing else: no url field exists for a grant URL to land in.
const workspaceDocHistoryEntrySchema = z.object({
  docLocation: browserPageDocLocationSchema,
  title: z.string(),
  lastVisitedAt: z.number(),
  visitCount: z.number()
})

export const workspaceDocHistoryEntriesSchema = salvagingArray(
  workspaceDocHistoryEntrySchema
).transform((entries) => normalizeWorkspaceDocHistoryEntries(entries))
