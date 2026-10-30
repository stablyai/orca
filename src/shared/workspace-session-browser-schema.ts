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

/** Persist document identity only; restore re-reads its current owner and mints a fresh grant rather than saving grant URLs. */
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

// z.object strips unlisted fields regardless of the static BrowserWorkspace annotation; declare additive fields here for restore.
export const browserWorkspaceSchema: z.ZodType<BrowserWorkspace> = z.object({
  id: z.string(),
  worktreeId: z.string(),
  label: z.string().optional(),
  sessionProfileId: z.string().nullable().optional(),
  // Preserve isolated storage across restarts even if the profile mirror is stale; tolerate pre-field sessions (#6923).
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
  // Both remote page identity fields must survive restore to reclaim a client-hosted page; older sessions may omit them.
  remoteBrowserPageId: z.string().nullable().optional(),
  remoteBrowserPageClientHosted: z.boolean().optional(),
  // Preserve the viewport preset across restart while accepting older sessions.
  viewportPresetId: browserViewportPresetIdSchema.nullable().optional(),
  // Without docLocation, a workspace document’s blank URL restores as New Tab.
  docLocation: browserPageDocLocationSchema.nullable().optional(),
  // Persist one-level conversion history; reject preview-scheme URLs at this read boundary as at every URL sink.
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
