import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { toSshExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isExpectedSshBrowserRoute } from '../workspace/workspace-browser-route-eligibility'
import { seedBrowserLinkTestStore, WORKSPACE } from './browser-link-open.test-fixture'
import { openRoutedHttpLink, type WorkspaceHttpLinkBrowserOpener } from './http-link-destinations'
import { registerWorkspaceHttpLinkBrowserOpener } from './http-link-routing'
import { markHydratedBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'

const TARGET = 'c1'
const LOCALHOST = 'http://localhost:3000/'
const ssh = { kind: 'ssh', connectionId: TARGET } as const
const initialState = useAppStore.getInitialState()

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

type OpenerRequest = Parameters<WorkspaceHttpLinkBrowserOpener>[0]
let held: OpenerRequest[] = []

function setThisDevice(thisDevice: boolean): void {
  useAppStore.setState({
    settings: {
      ...useAppStore.getState().settings!,
      openLinksInApp: true,
      browserSshWorkspaceRoutingEnabled: true,
      browserSshWorkspaceRoutingDisabledTargetIds: thisDevice ? [TARGET] : []
    }
  })
}

// Admission as the SSH branch of the tab opener runs it once the held request lands.
function admits(request: OpenerRequest): boolean {
  return isExpectedSshBrowserRoute(
    useAppStore.getState(),
    { state: 'enabled', provider: 'local-client' },
    { executionHostId: toSshExecutionHostId(TARGET), runtimeEnvironmentId: null },
    WORKSPACE,
    request.expectedSshConnectionId ?? '',
    Boolean(request.allowClientBrowserFallback || request.allowSshDeviceBrowser)
  )
}

beforeEach(() => {
  resetStore()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    activeWorkspaceExecutionHostId: toSshExecutionHostId(TARGET),
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: WORKSPACE,
          repoId: 'repo1',
          path: '/repo',
          hostId: toSshExecutionHostId(TARGET)
        })
      ]
    }
  })
  setThisDevice(false)
  held = []
  // Hold every open: admission is judged after routing changes underneath it.
  registerWorkspaceHttpLinkBrowserOpener((request) => {
    held.push(request)
    return new Promise<null>(() => {})
  })
})
afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
  resetStore()
})

describe('a routed SSH localhost link that skipped the chooser', () => {
  it('is never admitted to a desktop tab after routing switches to This device', () => {
    openRoutedHttpLink(LOCALHOST, {
      worktreeId: WORKSPACE,
      sourceOwner: ssh,
      forceDestination: 'orca',
      requireOwnerHostRoute: true
    })
    expect(held).toHaveLength(1)
    expect(held[0]!.expectedSshConnectionId).toBe(TARGET)
    expect(admits(held[0]!)).toBe(true)
    setThisDevice(true)
    expect(admits(held[0]!)).toBe(false)
  })

  it('still lets an explicit chooser pick of the Orca browser use This device', () => {
    openRoutedHttpLink(LOCALHOST, {
      worktreeId: WORKSPACE,
      sourceOwner: ssh,
      forceDestination: 'orca'
    })
    setThisDevice(true)
    expect(admits(held[0]!)).toBe(true)
  })
})
