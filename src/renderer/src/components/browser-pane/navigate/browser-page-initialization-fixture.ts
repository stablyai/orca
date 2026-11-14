import { act } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { applyWebRuntimeSessionTabsAnswer } from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import {
  ENV,
  WT
} from '@/runtime/web-session-tabs-sync/hydration/testing/host-session-mirror-frame-fixtures'

export const PLACEMENT = {
  kind: 'client' as const,
  browserHostClientId: 'host-a',
  browserHostGeneration: 1,
  pageHostGeneration: 0
}
export const WS = 'browser-workspace-a'
export function snapshot(
  url: string,
  version: number,
  state: 'pending' | 'stopped' | null = 'pending'
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-a',
    snapshotVersion: version,
    activeGroupId: 'host-group-a',
    activeTabId: 'tab-a',
    activeTabType: 'browser',
    tabs: [
      {
        type: 'browser',
        id: 'tab-a',
        title: url,
        browserWorkspaceId: WS,
        browserPageId: 'page-a',
        placement: PLACEMENT,
        url,
        initializationState: state ?? undefined,
        loading: state === 'pending',
        canGoBack: false,
        canGoForward: false,
        isActive: true
      }
    ]
  }
}
export const response = (result: RuntimeMobileSessionTabsResult) => ({
  id: 'answer',
  ok: true as const,
  result,
  _meta: { runtimeId: 'runtime-a' }
})
export async function publish(
  frame: RuntimeMobileSessionTabsResult,
  receivedFrame = nextReceivedSessionTabsFrame()
) {
  await act(async () => {
    await applyWebRuntimeSessionTabsAnswer(ENV, WT, {
      snapshot: frame,
      receivedFrame,
      runtimeId: 'runtime-a'
    })
  })
}
export function page() {
  return useAppStore.getState().browserPagesByWorkspace[WS]?.[0]
}
