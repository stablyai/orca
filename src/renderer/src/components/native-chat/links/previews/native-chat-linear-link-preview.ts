import { useAppStore } from '@/store'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

const previews = createHoverPreviewCache<LinearIssue>({ freshMs: 60_000, maxEntries: 200 })

export function linearLinkPreviewKey(identifier: string): string {
  return `linear:${identifier}`
}

/** Lets a reopened card or a re-rendered chip paint its last answer without a loading frame. */
export function readCachedLinearLinkPreview(identifier: string): LinearIssue | null {
  return previews.read(linearLinkPreviewKey(identifier))
}

/** Reads through the store, which owns Linear's host routing and shares its issue cache with the Tasks page. */
async function fetchIssue(identifier: string): Promise<LinearIssue | null> {
  // 'all' asks every connected workspace; the identifier names one issue in exactly one of them.
  const lease = useAppStore.getState().fetchLinearIssue(identifier, 'all').acquire()
  try {
    const view = await lease.waitForCurrentTerminal()
    if (view.kind === 'error') {
      throw view.error
    }
    return view.data
  } finally {
    lease.release()
  }
}

export function loadLinearLinkPreview(identifier: string): Promise<LinearIssue | null> {
  return previews.load(linearLinkPreviewKey(identifier), () => fetchIssue(identifier))
}
