import {
  beginPendingTab,
  afterPendingTab,
  isPendingTab
} from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import type { AppState } from '../../../types'
import { editorContentIsReferenced } from './workspace-editor-files'

/** Protect the content before a reducer publishes it, until the synchronous or main-owned tab settles. */
export function editorPlacementIntent(get: () => AppState, workspaceId: string) {
  let settle: ((outcome: string | null) => void) | undefined
  let entityId = ''
  const requestId = createBrowserUuid()
  const onSettled = (outcome: string | null) => {
    if (outcome === null && entityId && !editorContentIsReferenced(get(), entityId)) {
      get().closeFile(entityId, { captureRecentlyClosed: false })
    }
  }
  return {
    register(id: string) {
      entityId = id
      if (!settle) {
        settle = beginPendingTab(requestId, workspaceId, id, { kind: 'open' })
        afterPendingTab(requestId, onSettled)
      }
    },
    finish(open: (() => string) | null) {
      if (!isPendingTab(requestId)) {
        return
      }
      let tabId: string | null
      try {
        tabId = open?.() ?? null
      } catch (error) {
        settle?.(null)
        throw error
      }
      if (tabId === null) {
        settle?.(null)
      } else {
        afterPendingTab(tabId, (outcome) => settle?.(outcome))
      }
      return tabId
    }
  }
}
