import { describe, expect, it } from 'vitest'
import {
  applyDesktopRelayWrite,
  changedRelayKeys,
  forgetDesktopRelayKeys,
  type DesktopRelayHostWrite
} from './desktop-relay-ownership'
import type { WorkspaceSessionState } from './workspace-session-state-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay rules read tab ids and the two relay fields.
const partition = (fields: Partial<WorkspaceSessionState>) => fields as WorkspaceSessionState
const rows = (...ids: string[]): WorkspaceSessionState['tabsByWorktree'] => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay rules read tab ids only.
  'repo::/w': ids.map((id) => ({ id })) as WorkspaceSessionState['tabsByWorktree'][string]
})
const withTabs = (...ids: string[]) => partition({ tabsByWorktree: rows(...ids) })

function save(
  session: WorkspaceSessionState,
  relayIdsByTabId: Record<string, string>,
  write: Partial<DesktopRelayHostWrite> = {}
): WorkspaceSessionState {
  const { patch } = applyDesktopRelayWrite(
    session,
    { relayIdsByTabId, complete: true, ...write },
    null
  )
  return patch ? { ...session, ...patch } : session
}

/** A main writer setting these relay ids, as the writers in main do. */
function mainWrites(session: WorkspaceSessionState, relays: Record<string, string>) {
  return {
    ...forgetDesktopRelayKeys(
      session,
      changedRelayKeys(session.remoteSessionIdsByTabId, relays, [
        ...Object.keys(session.remoteSessionIdsByTabId ?? {}),
        ...Object.keys(relays)
      ])
    ),
    remoteSessionIdsByTabId: relays
  }
}

describe('desktop relay ownership', () => {
  it("removes the window's ended relay and keeps one main saved for another tab", () => {
    const first = save(
      { ...withTabs('tab-a'), remoteSessionIdsByTabId: { 'tab-b': 'ssh:box@@relay-b' } },
      { 'tab-a': 'ssh:box@@relay-a' }
    )

    expect(save(first, {}).remoteSessionIdsByTabId).toEqual({ 'tab-b': 'ssh:box@@relay-b' })
  })

  it('refuses to replace or drop a relay main moved into a tab', () => {
    const saved = save(withTabs('tab-a'), { 'tab-a': 'ssh:box@@relay-a' })
    const moved = mainWrites(saved, { 'tab-a': 'ssh:box@@relay-moved' })

    const stale = applyDesktopRelayWrite(
      moved,
      { relayIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' }, complete: true },
      null
    )

    expect(stale.refused).toBe(true)
    expect(stale.patch?.remoteSessionIdsByTabId ?? moved.remoteSessionIdsByTabId).toEqual({
      'tab-a': 'ssh:box@@relay-moved'
    })
    expect(save(moved, {}).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'ssh:box@@relay-moved' })
  })

  it('keeps the window owning a relay main rewrote with the same id', () => {
    const saved = save(withTabs('tab-a'), { 'tab-a': 'ssh:box@@relay-a' })
    const promoted = mainWrites(saved, { 'tab-a': 'ssh:box@@relay-a' })

    expect(save(promoted, {}).remoteSessionIdsByTabId).toBeUndefined()
  })

  it('does not revive a relay for a tab main closed', () => {
    const saved = save(withTabs('tab-a'), { 'tab-a': 'ssh:box@@relay-a' })
    const closed = { ...mainWrites(saved, {}), tabsByWorktree: rows() }

    const stale = applyDesktopRelayWrite(
      closed,
      { relayIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' }, complete: true },
      null
    )

    expect(stale.refused).toBe(true)
    expect(stale.patch?.remoteSessionIdsByTabId).toBeUndefined()
  })

  it('leaves relays alone on a host the window does not speak for in full', () => {
    const saved = save(withTabs('tab-a'), { 'tab-a': 'ssh:box@@relay-a' })

    expect(save(saved, {}, { complete: false }).remoteSessionIdsByTabId).toEqual({
      'tab-a': 'ssh:box@@relay-a'
    })
  })

  it('a delta removes only the ids it names', () => {
    const saved = save(withTabs('tab-a', 'tab-b'), {
      'tab-a': 'ssh:box@@relay-a',
      'tab-b': 'ssh:box@@relay-b'
    })

    expect(save(saved, {}, { removedTabIds: ['tab-a'] }).remoteSessionIdsByTabId).toEqual({
      'tab-b': 'ssh:box@@relay-b'
    })
  })

  it('adopts a relay saved before ownership was recorded only when offered', () => {
    const legacy = partition({
      remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a', 'tab-m': 'ssh:box@@relay-m' }
    })

    const { patch } = applyDesktopRelayWrite(
      legacy,
      { relayIdsByTabId: {}, complete: true },
      () => ({ 'tab-a': 'ssh:box@@relay-a' })
    )

    expect(patch?.remoteSessionIdsByTabId).toEqual({ 'tab-m': 'ssh:box@@relay-m' })
  })
})
