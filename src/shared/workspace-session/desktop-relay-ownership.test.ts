import { describe, expect, it } from 'vitest'
import { applyDesktopRelayWrite, withMainRelayKeys } from './desktop-relay-ownership'
import type { WorkspaceSessionState } from './workspace-session-state-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay rules read only the two relay fields.
const partition = (fields: Partial<WorkspaceSessionState>) => fields as WorkspaceSessionState
const noLegacy = () => ({})

/** Apply the window's ids, then return what the partition stores afterwards. */
function save(
  session: WorkspaceSessionState,
  relayIdsByTabId: Record<string, string>,
  complete = true
): WorkspaceSessionState {
  const patch = applyDesktopRelayWrite(session, { relayIdsByTabId, complete }, noLegacy)
  return patch ? { ...session, ...patch } : session
}

describe('desktop relay ownership', () => {
  it("removes the window's ended relay and keeps one main saved for another tab", () => {
    const first = save(partition({ remoteSessionIdsByTabId: { 'tab-b': 'ssh:box@@relay-b' } }), {
      'tab-a': 'ssh:box@@relay-a'
    })

    const ended = save(first, {})

    expect(ended.remoteSessionIdsByTabId).toEqual({ 'tab-b': 'ssh:box@@relay-b' })
  })

  it('keeps the relay main moved into a tab when the window still sends or drops the old one', () => {
    const saved = save(partition({}), { 'tab-a': 'ssh:box@@relay-a' })
    const moved = withMainRelayKeys(
      { ...saved, remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-moved' } },
      ['tab-a']
    )

    expect(save(moved, { 'tab-a': 'ssh:box@@relay-stale' }).remoteSessionIdsByTabId).toEqual({
      'tab-a': 'ssh:box@@relay-moved'
    })
    expect(save(moved, {}).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'ssh:box@@relay-moved' })
  })

  it('keeps a relay main wrote with the same id the window had saved', () => {
    const saved = save(partition({}), { 'tab-a': 'ssh:box@@relay-a' })
    const promoted = withMainRelayKeys(saved, ['tab-a'])

    expect(save(promoted, {}).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'ssh:box@@relay-a' })
  })

  it('does not revive a relay main retired with its tab', () => {
    const saved = save(partition({}), { 'tab-a': 'ssh:box@@relay-a' })
    const closed = withMainRelayKeys({ ...saved, remoteSessionIdsByTabId: {} }, ['tab-a'])

    expect(save(closed, { 'tab-a': 'ssh:box@@relay-a' }).remoteSessionIdsByTabId).toEqual({})
  })

  it('leaves relays alone on a host the window does not speak for in full', () => {
    const saved = save(partition({}), { 'tab-a': 'ssh:box@@relay-a' })

    expect(save(saved, {}, false).remoteSessionIdsByTabId).toEqual({ 'tab-a': 'ssh:box@@relay-a' })
  })

  it('adopts a relay saved before ownership was recorded once, never one main took over', () => {
    const legacy = partition({
      remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a', 'tab-m': 'ssh:box@@relay-m' }
    })
    const adoptBoth = () => ({ 'tab-a': 'ssh:box@@relay-a', 'tab-m': 'ssh:box@@relay-m' })
    const revoked = withMainRelayKeys(legacy, ['tab-m'])

    const patch = applyDesktopRelayWrite(
      revoked,
      { relayIdsByTabId: {}, complete: true },
      adoptBoth
    )

    expect(patch?.remoteSessionIdsByTabId).toEqual({ 'tab-m': 'ssh:box@@relay-m' })
  })
})
