/* Why: the browser slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget; the
 * schemas themselves are unchanged apart from the per-entry tolerance the
 * session schema now declares everywhere. */
import { z } from 'zod'
import type { BrowserWorkspace } from './browser-workspace-types'
import { normalizeBrowserHistoryEntries } from './workspace-session-browser-history'
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
  docLocation: browserPageDocLocationSchema.nullable().optional()
})

const browserHistoryEntrySchema = z.object({
  url: z.string(),
  normalizedUrl: z.string(),
  title: z.string(),
  lastVisitedAt: z.number(),
  visitCount: z.number()
})

export const browserHistoryEntriesSchema = salvagingArray(browserHistoryEntrySchema).transform(
  (entries) => normalizeBrowserHistoryEntries(entries)
)
