import { buildSearchUrl, type SearchUrlOptions } from '../../../../shared/browser-url'
import type { OpenWorkspaceBrowserTabRequest } from '@/lib/workspace-browser-tab-open'
import type { TabEntryActionClassification } from './tab-create-entry-classifier'

type NetworkTabEntryClassification = Extract<
  TabEntryActionClassification,
  { kind: 'explicit-url' | 'host-url' | 'search' }
>

export function isNetworkTabEntry(
  classification: TabEntryActionClassification
): classification is NetworkTabEntryClassification {
  return (
    classification.kind === 'explicit-url' ||
    classification.kind === 'host-url' ||
    classification.kind === 'search'
  )
}

export function getNetworkTabRequest(
  classification: NetworkTabEntryClassification,
  { worktreeId, groupId }: { worktreeId: string; groupId: string },
  searchUrlOptions?: SearchUrlOptions
): OpenWorkspaceBrowserTabRequest {
  const target = { workspaceId: worktreeId, targetGroupId: groupId }
  if (classification.kind === 'search') {
    return {
      ...target,
      url: buildSearchUrl(classification.query, classification.engine, searchUrlOptions),
      intent: { kind: 'search', engine: classification.engine }
    }
  }
  return { ...target, url: classification.url, intent: { kind: 'url' } }
}
