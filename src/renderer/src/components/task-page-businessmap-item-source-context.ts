import type { BusinessmapCard, BusinessmapSite } from '../../../shared/businessmap-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'

export function bindTaskPageBusinessmapItemSourceContext(args: {
  card: BusinessmapCard
  sites: readonly BusinessmapSite[]
  sourceContext: TaskSourceContext | null
  selectedSiteId?: string | null
}): TaskSourceContext | null {
  if (args.sourceContext?.provider !== 'businessmap') {
    return null
  }
  const site =
    args.sites.find((candidate) => candidate.id === args.selectedSiteId) ?? args.sites[0] ?? null
  if (!site) {
    return null
  }
  return normalizeTaskSourceContext({
    ...args.sourceContext,
    providerIdentity: {
      provider: 'businessmap',
      subdomain: site.subdomain,
      boardId: args.card.boardId
    },
    accountLabel: site.accountName || site.displayName || site.subdomain
  })
}
