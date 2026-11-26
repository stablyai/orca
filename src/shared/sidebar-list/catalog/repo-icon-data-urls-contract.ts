import * as z from 'zod'
import { getRepoExecutionHostId } from '../../execution-host/execution-host'

/** Longest data URL one icon may reply with. */
export const MAX_REPO_ICON_DATA_URL_BYTES = 16 * 1024
/** Bounds a reply to 256 KiB by construction: each id answers with at most one capped icon. */
export const MAX_REPO_ICON_IDS_PER_READ = 16

export const RepoIconDataUrlsParams = z.object({
  ids: z.array(z.string().min(1).max(64)).max(MAX_REPO_ICON_IDS_PER_READ)
})

/** Return one icon per requested ID in order; null means missing/over-budget and lets clients draw fallbacks. */
export type RepoIconDataUrlsReply = {
  icons: { id: string; dataUrl: string | null }[]
}

/** A repo's key in repo.list's `repoIconIds` and the feed's `repoIcons` domain: one repo id can be registered on two hosts. */
export function repoIconFeedKey(
  repo: { id: string } & Parameters<typeof getRepoExecutionHostId>[0]
): string {
  return `${getRepoExecutionHostId(repo)}|${repo.id}`
}
