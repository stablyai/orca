/* Why: the browser slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget; the
 * schemas themselves are unchanged apart from the per-entry tolerance the
 * session schema now declares everywhere. */
import { z } from 'zod'
import type { BrowserWorkspace } from './types'
import { normalizeBrowserHistoryEntries } from './workspace-session-browser-history'
import { salvagingArray } from './zod-salvage'

const browserLoadErrorSchema = z.object({
  code: z.number(),
  description: z.string(),
  validatedUrl: z.string()
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
  createdAt: z.number()
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
  // Why: optional+nullable so sessions persisted before viewport presets were
  // added still validate; without this, zod would strip the field during
  // restore and reset the user's chosen preset on every app restart.
  viewportPresetId: browserViewportPresetIdSchema.nullable().optional()
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
