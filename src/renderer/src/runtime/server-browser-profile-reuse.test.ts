import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionBrowserTab } from '../../../shared/runtime-types'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  URL_TO_OPEN,
  WORKSPACE
} from '../lib/browser-link-open.test-fixture'
import { selectBrowserLinkDestination } from '../lib/browser-link-destination'
import { captureLinkOpenIntent } from '../lib/link-open-intent'
import { makeWorktree } from '../store/slices/store-test-helpers'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph/mobile-session-snapshots'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'

function desktopSnapshot(profileId: string | null | undefined) {
  const host = createBrowserLinkTestStore()
  const workspace = host.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
    targetGroupId: 'b',
    sessionProfileId: profileId,
    browserRuntimeEnvironmentId: null,
    executionHostId: 'local',
    activate: false
  })
  host.setState({
    browserTabsByWorktree: { [WORKSPACE]: [{ ...workspace, sessionProfileId: profileId }] }
  })
  const snapshot = buildMobileSessionTabSnapshots(host.getState()).find(
    (candidate) => candidate.worktree === WORKSPACE
  )
  if (!snapshot) {
    throw new Error('Missing desktop snapshot')
  }
  return {
    ...snapshot,
    tabs: snapshot.tabs.filter(
      (tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser'
    )
  }
}

function mirrorOnClient(snapshot: ReturnType<typeof desktopSnapshot>) {
  const client = createBrowserLinkTestStore()
  client.setState({
    activeWorkspaceExecutionHostId: 'runtime:server',
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'runtime:server' })]
    }
  })
  client.setState(applyWebSessionTabsSnapshot(client.getState(), snapshot, 'server'))
  return client
}

function destination(profileId: string | null) {
  return browserLinkTestDestination({
    executionHostId: 'runtime:server',
    browserRuntimeEnvironmentId: 'server',
    profileHostId: 'runtime:server',
    sessionProfileId: profileId
  })
}

function selectPage(client: ReturnType<typeof mirrorOnClient>, profileId: string | null) {
  const state = client.getState()
  const browserTab = state.unifiedTabsByWorktree[WORKSPACE]?.find(
    (tab) => tab.contentType === 'browser'
  )
  if (!browserTab) {
    throw new Error('Missing mirrored browser tab')
  }
  return selectBrowserLinkDestination(
    state,
    destination(profileId),
    captureLinkOpenIntent(state, WORKSPACE, browserTab.id, { explicitSourceGroup: true })
  )
}

describe('server browser profile publication and link reuse', () => {
  it.each([null, 'default', 'isolated-login'])(
    'reuses a desktop-published page only for its authoritative profile (%s)',
    (profileId) => {
      const snapshot = desktopSnapshot(profileId)
      const client = mirrorOnClient(snapshot)
      const row = snapshot.tabs[0]!
      expect(row.browserProfileId).toBe(profileId ?? 'default')
      expect(selectPage(client, profileId)).toMatchObject({
        status: 'ready',
        match: { browserPageId: row.browserPageId, browserWorkspaceId: row.browserWorkspaceId }
      })
      expect(selectPage(client, 'another-login')).toMatchObject({ status: 'ready', match: null })
    }
  )

  it('keeps unknown legacy metadata ineligible for both default and named-profile reuse', () => {
    const snapshot = desktopSnapshot(undefined)
    expect(snapshot.tabs[0]?.browserProfileId).toBeUndefined()
    const client = mirrorOnClient(snapshot)
    for (const profileId of [null, 'isolated-login']) {
      expect(selectPage(client, profileId)).toMatchObject({ status: 'ready', match: null })
    }
  })

  it('does not infer a remote page profile from its mirrored workspace metadata', () => {
    const client = mirrorOnClient(desktopSnapshot('isolated-login'))
    const republished = buildMobileSessionTabSnapshots(client.getState()).find(
      (snapshot) => snapshot.worktree === WORKSPACE
    )
    const row = republished?.tabs.find((tab) => tab.type === 'browser')
    expect(row).toBeDefined()
    expect(row?.type === 'browser' && row.browserProfileId).toBeUndefined()
  })

  it('clears a previously known identity when an old peer republishes without it', () => {
    const snapshot = desktopSnapshot('isolated-login')
    const client = mirrorOnClient(snapshot)
    client.setState(
      applyWebSessionTabsSnapshot(
        client.getState(),
        {
          ...snapshot,
          snapshotVersion: snapshot.snapshotVersion + 1,
          tabs: snapshot.tabs.map(({ browserProfileId: _profileId, ...row }) => row)
        },
        'server'
      )
    )
    expect(selectPage(client, 'isolated-login')).toMatchObject({ status: 'ready', match: null })
  })
})
