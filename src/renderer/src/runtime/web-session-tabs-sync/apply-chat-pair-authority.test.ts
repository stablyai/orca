// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { resolveChatPairAuthority } from '@/store/slices/tabs/terminal-chat-pair-authority'
import { selectUnifiedTerminalTabFields } from '@/components/terminal-pane/terminal-unified-tab-lookup'
import {
  A,
  B,
  TERMINAL_TAB_ID,
  WT,
  applyHostSnapshot,
  effectivePair,
  installFakeHost,
  makeHostPairSnapshot,
  resetPairedStore,
  storedPair
} from '../terminal-chat-pair-host-test-rig'

function paneSaysChat(): boolean {
  return selectUnifiedTerminalTabFields(
    useAppStore.getState().unifiedTabsByWorktree,
    WT,
    TERMINAL_TAB_ID
  ).isChatViewMode
}

describe('applying a paired host snapshot to the chat pair', () => {
  let host: ReturnType<typeof installFakeHost>
  beforeEach(() => {
    resetPairedStore()
    host = installFakeHost()
  })

  it('adopts an absent host view verbatim once the host owns the pair', () => {
    // The client holds chat in both indices, from a host without the marker.
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'chat', owner: A }))
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: A })
    expect(resolveChatPairAuthority(useAppStore.getState(), WT)).toBe('legacy')

    // Old host: a snapshot that omits viewMode keeps the client's view.
    applyHostSnapshot(makeHostPairSnapshot({ marker: false }))
    expect(storedPair().row).toBe('chat')
    expect(storedPair().unified).toBe('chat')
    expect(paneSaysChat()).toBe(true)

    // Host upgrade: the same absence under the marker is host truth.
    applyHostSnapshot(makeHostPairSnapshot({}))
    expect(resolveChatPairAuthority(useAppStore.getState(), WT)).toBe('host')
    expect(storedPair()).toEqual({ row: undefined, unified: undefined, owner: undefined })
    expect(paneSaysChat()).toBe(false)
    expect(effectivePair()).toEqual({})
    expect(host.pairWrites()).toEqual([])
  })

  it('keeps the client view on a host without the marker', () => {
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'chat', owner: A }))
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'terminal' }))
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: A })
  })

  it('adopts a host chat with no owner as ownerless', () => {
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'chat', owner: A }))
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat' }))
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: undefined })
  })

  it('adopts a host move of the owner', () => {
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: A }))
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: B }))
    expect(storedPair()).toEqual({ row: 'chat', unified: 'chat', owner: B })
  })

  it('reads a present owner outside the tree as terminal instead of an ownerless chat', () => {
    const closed = '99999999-9999-4999-8999-999999999999'
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: closed }))
    expect(storedPair()).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    expect(paneSaysChat()).toBe(false)
  })

  it('records the marker per applied snapshot, so a host downgrade returns to legacy', () => {
    applyHostSnapshot(makeHostPairSnapshot({ viewMode: 'chat', owner: A }))
    expect(useAppStore.getState().chatViewHostOwnedByWorktree).toEqual({ [WT]: true })
    applyHostSnapshot(makeHostPairSnapshot({ marker: false, viewMode: 'chat', owner: A }))
    expect(useAppStore.getState().chatViewHostOwnedByWorktree).toEqual({})
    expect(resolveChatPairAuthority(useAppStore.getState(), WT)).toBe('legacy')
  })
})
