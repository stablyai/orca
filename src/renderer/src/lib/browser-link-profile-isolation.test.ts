import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import type { BrowserSessionProfile } from '../../../shared/browser-workspace-types'
import { getDefaultSettings } from '../../../shared/constants'
import { openFileInBrowserTab } from './file-preview'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { captureLinkOpenIntent } from './link-open-intent'
import type { BrowserOpenOutcome } from './browser-link-destination'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), ensureProfile: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))

let store: BrowserLinkTestStore
beforeEach(() => {
  createStoreCascadesMockApi()
  Object.defineProperty(window.api, 'browser', {
    value: {
      sessionEnsureManagedProfile: mocks.ensureProfile,
      notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined)
    },
    configurable: true
  })
  mocks.ensureProfile.mockReset()
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
  store.setState({
    defaultBrowserSessionProfileIdByHostId: { local: 'default' },
    browserSessionProfilesByHostId: {
      local: [
        {
          id: 'default',
          scope: 'default',
          partition: 'persist:shared',
          label: 'Default',
          source: null
        }
      ]
    }
  })
})

function open(surface: 'http' | 'html'): Promise<BrowserOpenOutcome> {
  const linkContext = {
    linkIntent: captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
  }
  if (surface === 'http') {
    return openWorkspaceBrowserTabForLink({
      workspaceId: WORKSPACE,
      url: URL_TO_OPEN,
      intent: { kind: 'url' },
      linkContext
    })
  }
  return new Promise((resolve) =>
    openFileInBrowserTab({
      filePath: '/repo/report.html',
      worktreeId: WORKSPACE,
      linkContext,
      onLinkOutcome: resolve
    })
  )
}

describe.each(['repo', 'worktree'] as const)('%s browser profile isolation', (scope) => {
  it.each(['http', 'html'] as const)(
    'opens %s links in the managed profile and only reuses pages in that profile',
    async (surface) => {
      const profile: BrowserSessionProfile = {
        id: 'managed',
        scope: 'isolated',
        partition: 'persist:managed',
        label: 'Workspace login',
        source: null,
        owner: { kind: scope, id: scope === 'repo' ? 'repo1' : WORKSPACE }
      }
      mocks.ensureProfile.mockResolvedValue(profile)
      store.setState((state) => ({
        settings: { ...getDefaultSettings('/home/test'), browserProfileScope: scope },
        browserSessionProfilesByHostId: {
          local: [...state.browserSessionProfilesByHostId.local!, profile]
        }
      }))
      const shared = store
        .getState()
        .createBrowserTab(
          WORKSPACE,
          surface === 'http' ? URL_TO_OPEN : 'file:///repo/report.html',
          {
            targetGroupId: 'b',
            executionHostId: 'local',
            browserRuntimeEnvironmentId: null,
            sessionProfileId: 'default',
            activate: false
          }
        )

      const opened = await open(surface)
      expect(opened.status).toBe('opened')
      if (opened.status !== 'opened') {
        throw new Error('Expected scoped browser page')
      }
      expect(opened.result.browserWorkspaceId).not.toBe(shared.id)
      expect(
        store
          .getState()
          .browserTabsByWorktree[WORKSPACE]?.find(
            (workspace) => workspace.id === opened.result.browserWorkspaceId
          )
      ).toMatchObject({ sessionProfileId: profile.id, sessionPartition: profile.partition })
      expect(await open(surface)).toEqual(opened)
      expect(store.getState().browserTabsByWorktree[WORKSPACE]).toHaveLength(2)
    }
  )
})

it.each([undefined, null])(
  'keeps the shared local default independent of the selected remote profile (%s)',
  async (localDefault) => {
    store.setState({
      browserSessionHostIdOverride: 'runtime:remote',
      defaultBrowserSessionProfileId: 'remote-only',
      defaultBrowserSessionProfileIdByHostId: { local: localDefault }
    })
    const opened = await open('http')
    if (opened.status !== 'opened') {
      throw new Error('Expected local browser page')
    }
    expect(
      store
        .getState()
        .browserTabsByWorktree[WORKSPACE]?.find(
          (workspace) => workspace.id === opened.result.browserWorkspaceId
        )
    ).toMatchObject({ sessionProfileId: null, sessionPartition: 'persist:shared' })
  }
)

it('holds a link in an isolated partition until its workspace profile is minted', async () => {
  let mintProfile: ((profile: BrowserSessionProfile) => void) | undefined
  mocks.ensureProfile.mockImplementation(
    () => new Promise<BrowserSessionProfile>((resolve) => (mintProfile = resolve))
  )
  store.setState({
    settings: { ...getDefaultSettings('/home/test'), browserProfileScope: 'worktree' }
  })
  const opened = await open('http')
  if (opened.status !== 'opened') {
    throw new Error('Expected pending browser page')
  }
  const pending = store
    .getState()
    .browserTabsByWorktree[WORKSPACE]?.find(
      (workspace) => workspace.id === opened.result.browserWorkspaceId
    )
  expect(pending?.sessionProfileId).toBeTruthy()
  expect(pending?.sessionProfileId).not.toBe('default')
  expect(pending?.sessionPartition).toBe(
    `persist:orca-browser-unminted-${pending?.sessionProfileId}`
  )
  expect(store.getState().managedBrowserProfileStatusById[pending?.sessionProfileId ?? '']).toBe(
    'pending'
  )

  mintProfile?.({
    id: 'minted',
    scope: 'isolated',
    partition: 'persist:minted',
    label: 'Workspace login',
    source: null,
    owner: { kind: 'worktree', id: WORKSPACE }
  })
  await vi.waitFor(() =>
    expect(
      store
        .getState()
        .browserTabsByWorktree[WORKSPACE]?.find(
          (workspace) => workspace.id === opened.result.browserWorkspaceId
        )
    ).toMatchObject({ sessionProfileId: 'minted', sessionPartition: null })
  )
})
