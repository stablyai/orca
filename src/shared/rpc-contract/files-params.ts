import { z } from 'zod'
import { QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS } from '../quick-open-path-search'
import { FileOpen, WorktreeSelector } from './files-target-params'

export const FilePathSearch = WorktreeSelector.extend({
  query: z.string().max(QUICK_OPEN_REMOTE_QUERY_MAX_CODE_UNITS).default(''),
  limit: z.number().int().positive().max(32).default(16),
  excludePaths: z.array(z.string()).optional(),
  mode: z.literal('quick-open').optional()
})

export const ResolveTerminalPath = WorktreeSelector.extend({
  pathText: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing path text')),
  terminal: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  cwd: z
    .unknown()
    .transform((v) => (typeof v === 'string' && v.length > 0 ? v : null))
    .nullable()
    .optional(),
  crossWorkspace: z
    .unknown()
    .transform((v) => v === true)
    .optional(),
  nativeChatContext: z
    .object({
      tabId: z.string().min(1),
      sessionId: z.string().min(1)
    })
    .optional()
})

export const FileOpenDiff = FileOpen.extend({
  staged: z.boolean().optional()
})

export const DocPreviewFileRead = FileOpen.extend({
  entryRelativePath: z.string().min(1),
  implicitRootRelativePath: z.string().nullable(),
  authorizedRootRelativePaths: z.array(z.string())
})

export const FileTreePath = WorktreeSelector.extend({
  relativePath: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

export const ServerDirectoryBrowse = z.object({
  path: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string())
})

export const FileReadChunk = FileOpen.extend({
  offset: z.number().int().nonnegative(),
  length: z
    .number()
    .int()
    .positive()
    .max(512 * 1024)
})

export const FileSearch = WorktreeSelector.extend({
  query: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing search query')),
  caseSensitive: z.boolean().optional(),
  wholeWord: z.boolean().optional(),
  useRegex: z.boolean().optional(),
  includePattern: z.string().optional(),
  excludePattern: z.string().optional(),
  maxResults: z.number().int().positive().optional()
})

// Why: `maxResults` is a new optional field (wire rule 1) — an older host strips it and keeps its
// own default. It existed only on the Electron IPC hop, so "the client names its cap and a full page
// means there is more" was true for desktop and merely incidental for web and mobile, which were
// saved by `remoteFileContentBudget` defaulting the cap inside `listRuntimeFiles`.
export const FileListAll = WorktreeSelector.extend({
  excludePaths: z.array(z.string()).optional(),
  maxResults: z.number().int().positive().optional()
})

export const FileUnwatch = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})
