import { communityQueryNumber } from './community-pr-query'
import type { CommunityPullRequest } from './community-catalog'
import type { CustomBuildChange, CustomBuildInfo } from './custom-build'

export type CommunityInstalledSnapshot = {
  build: CustomBuildInfo | null
  sources: CommunityPullRequest[]
  unavailable: number[]
}

export type CommunityInstalledChange = {
  change: CustomBuildChange
  proposal: CommunityPullRequest | null
  imageUrls: readonly string[]
  previewSource: 'manifest' | 'proposal'
}

export function communityInstalledChanges(
  snapshot: CommunityInstalledSnapshot,
  query = '',
  imagesOnly = false
): CommunityInstalledChange[] {
  const number = communityQueryNumber(query)
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return (snapshot.build?.changes ?? []).flatMap<CommunityInstalledChange>((change) => {
    const proposal =
      snapshot.sources.find((source) => source.number === change.pullRequest?.number) ?? null
    const pinned = change.imageUrls?.length ? change.imageUrls : null
    const imageUrls = pinned ?? proposal?.imageUrls ?? []
    const text = [
      change.id,
      change.title,
      change.description,
      change.pullRequest?.url,
      proposal?.title,
      proposal?.author
    ]
      .join(' ')
      .toLowerCase()
    if (
      (imagesOnly && !imageUrls.length) ||
      (number !== null
        ? change.pullRequest?.number !== number
        : !terms.every((term) => text.includes(term)))
    ) {
      return []
    }
    return [{ change, proposal, imageUrls, previewSource: pinned ? 'manifest' : 'proposal' }]
  })
}
