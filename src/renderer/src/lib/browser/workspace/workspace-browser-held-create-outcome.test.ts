import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import {
  seedBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '../navigation/browser-link-open.test-fixture'
import type { BrowserLinkDestination } from '../navigation/browser-link-destination'
import type { OpenWorkspaceBrowserTabRequest } from './workspace-browser-tab-open'
import { materializedBrowserLinkOutcome } from './workspace-browser-link-open'
import { markHydratedBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'

const initialState = useAppStore.getInitialState()

// An owner-pinned remote create was admitted, then held; these are its later outcomes.
const destination: BrowserLinkDestination = {
  worktreeId: WORKSPACE,
  executionHostId: 'local',
  browserRuntimeEnvironmentId: 'env-a',
  profileHostId: 'local',
  sessionProfileId: null,
  sessionPartition: null,
  resource: { kind: 'website', url: URL_TO_OPEN }
}

function request(isCurrent: boolean): OpenWorkspaceBrowserTabRequest {
  return {
    workspaceId: WORKSPACE,
    url: URL_TO_OPEN,
    linkContext: { linkIntent: null, isCurrentRequest: () => isCurrent }
  } as unknown as OpenWorkspaceBrowserTabRequest
}

// The page-handle ownership check needs a whole-store reset to carry hydrated handles.
function resetStore(): void {
  useAppStore.setState(
    {
      ...initialState,
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({
        ...initialState.remoteBrowserPageHandlesByPageId
      })
    },
    true
  )
}

beforeEach(() => {
  resetStore()
  seedBrowserLinkTestStore(useAppStore)
})
afterEach(resetStore)

describe('a held remote create that lands later', () => {
  it('reports superseded when a newer link open replaced it while held', () => {
    expect(materializedBrowserLinkOutcome(request(false), destination, 'remote-1')).toEqual({
      status: 'superseded'
    })
  })

  it('reports refused when the workspace no longer routes to that runtime', () => {
    // The fixture workspace now routes locally, not to env-a.
    expect(materializedBrowserLinkOutcome(request(true), destination, 'remote-1')).toEqual({
      status: 'refused'
    })
  })
})
