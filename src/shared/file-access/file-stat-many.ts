/** One `files.statMany` call stats at most this many paths (a manifest page for cloud file sync). */
export const FILE_STAT_MANY_MAX = 2000

/** Stat of one path; `null` when it is absent, `{ error }` when the host refused or failed. */
export type FileStatManyEntry =
  | { size: number; mtime: number; type: 'file' | 'directory' | 'symlink' }
  | { error: string }
  | null

export type FileStatManyResult = { entries: FileStatManyEntry[] }
