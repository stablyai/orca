// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createRuntimeAgentProjections } from '../../../main/runtime/construction/runtime-agent-projections'
import { withSessionTabsSenderDelta } from '../../../main/runtime/rpc/methods/session-tabs-sender-delta'
import { createSessionTabsRetirementProofDelta } from '../../../main/runtime/rpc/methods/session-tabs-retirement-proof-delta'
import { MIRROR_LEAVES_STEP_1 } from '../../../main/runtime/runtime-leaf-record-projection.test-fixture'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../../main/runtime/runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeSyncWindowGraphResult } from '../../../shared/runtime-session-contracts'
import {
  agentSenderIndexWorkForTest,
  selectAgentSenderAssociation
} from './agent-sender-associations'
import { agentSenderAliasWorkForTest } from './agent-sender-alias-projection'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { useAgentMessageSenderView } from '@/components/native-chat/native-chat-agent-message-sender-view'
import {
  initialStore,
  resetSenderStore
} from '@/components/native-chat/native-chat-agent-sender.test-fixture'

beforeEach(() => resetSenderStore())
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
})

const leafOf = (i: number) => `${(i + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
const handleOf = (i: number) => `term_${i}`
const sender = (i: number) => ({
  party: { address: handleOf(i), terminalHandle: handleOf(i), orcaSessionId: null },
  name: `Worker ${i}`
})

/** A host runtime with live terminals split over two worktrees, and the wire as JSON. */
function host(n: number) {
  const leaves: RuntimeLeafRecord[] = []
  const ptys: RuntimePtyWorktreeRecord[] = []
  const open = (i: number, worktreeId: string) => {
    leaves.push({ ...MIRROR_LEAVES_STEP_1[0], tabId: `tab${i}`, worktreeId, ptyId: `pty-${i}` })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher reads only these fields.
    ptys.push({ ptyId: `pty-${i}`, incarnationId: 'inc', worktreeId } as RuntimePtyWorktreeRecord)
  }
  for (let i = 0; i < n; i++) {
    open(i, i % 2 ? 'w2' : 'w1')
  }
  const start = () =>
    createRuntimeAgentProjections(
      {
        getExistingOrchestrationDb: () => null,
        resolveOrchestrationWorkerServer: () => {
          throw new Error('unpaired')
        }
      },
      {
        getDb: () => null,
        getLeaves: () => leaves,
        getPtys: () => ptys,
        paneOf: () => ({ tabId: null, paneKey: null, recordedAtGraphSequence: 0 }),
        issueLeafHandle: (leaf) => handleOf(Number(leaf.tabId.slice(3))),
        issuePtyHandle: () => '',
        makePaneKey: (leaf) => `${leaf.tabId}:${leafOf(Number(leaf.tabId.slice(3)))}`,
        getWorktreeId: () => null,
        getHandleForPaneKey: () => null,
        getPaneKey: () => null,
        getDispatchAuthority: () => null,
        getAgentStatusSnapshot: () => [],
        getSessionRecords: () => null
      }
    ).senders
  let senders = start()
  const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  let rowsSent = 0
  const count = (publication: { associations: unknown[] } | undefined) => {
    rowsSent += publication?.associations.length ?? 0
  }
  /** The window's graph sync: it sends the revision it applied, and applies only rows. */
  const graphReply = () => {
    const base = useAppStore.getState().agentSenderPublicationsByHost.local?.['*']?.revision
    return wire<RuntimeSyncWindowGraphResult>({
      ...({} as RuntimeSyncWindowGraphResult),
      ...senders.buildForGraph(base)
    })
  }
  const applyGraph = (result: RuntimeSyncWindowGraphResult) => {
    count(result.agentSenderAssociations as { associations: unknown[] } | undefined)
    if (!result.agentSenderRevision) {
      useAppStore.getState().setAgentSenderPublication('local', result.agentSenderAssociations)
    }
  }
  let stream = withSessionTabsSenderDelta(createSessionTabsRetirementProofDelta(undefined))
  let version = 0
  /** One session-tab stream frame for a worktree, through that stream's encoder and the wire. */
  const frame = (worktree: string) =>
    wire<RuntimeMobileSessionTabsResult>(
      stream({
        worktree,
        publicationEpoch: 'host',
        snapshotVersion: ++version,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [],
        agentSenderAssociations: senders.buildForFrame(worktree)
      })
    )
  const applyFrame = (snapshot: RuntimeMobileSessionTabsResult) => {
    count(snapshot.agentSenderAssociations as { associations: unknown[] } | undefined)
    useAppStore.setState(
      applyWebSessionTabsSnapshot(useAppStore.getState(), snapshot, LOCAL_STRUCTURED_SESSION_OWNER)
    )
  }
  const deliverAll = () =>
    act(() => {
      applyGraph(graphReply())
      applyFrame(frame('w1'))
      applyFrame(frame('w2'))
    })
  return {
    open,
    leaves,
    get senders() {
      return senders
    },
    rowsSent: () => rowsSent,
    graphReply,
    applyGraph,
    frame,
    applyFrame,
    deliverAll,
    reconnect: () => {
      stream = withSessionTabsSenderDelta(createSessionTabsRetirementProofDelta(undefined))
    },
    replaceRuntime: () => {
      senders = start()
    }
  }
}

const located = (i: number) =>
  selectAgentSenderAssociation(useAppStore.getState(), 'local', sender(i))?.paneKey

it.each([100, 1000])(
  'sends and reduces nothing for unchanged sender data, at %i live terminals',
  (n) => {
    const h = host(n)
    useAppStore.getState().setAgentSenderPublication('runtime:other', {
      associations: [{ identity: 'term_far', paneKey: 'far:pane', worktreeId: 'far' }],
      principals: [],
      attachments: []
    })
    let renders = 0
    let otherRenders = 0
    renderHook(() => {
      renders++
      return useAgentMessageSenderView(sender(0), 'w1', { kind: 'local' })
    })
    renderHook(() => {
      otherRenders++
      return useAgentMessageSenderView(
        {
          ...sender(0),
          party: { ...sender(0).party, address: 'term_far', terminalHandle: 'term_far' }
        },
        'far',
        { kind: 'environment', environmentId: 'other' }
      )
    })
    h.deliverAll()
    expect(located(0)).toBe(`tab0:${leafOf(0)}`)
    const settled = {
      revision: h.senders.publisher.current().revision,
      store: useAppStore.getState().agentSenderPublicationsByHost,
      index: agentSenderIndexWorkForTest(),
      aliases: agentSenderAliasWorkForTest(),
      rows: h.rowsSent(),
      renders,
      otherRenders
    }
    // Status and title changes, and repeats, alternating both transports.
    for (let k = 0; k < 5; k++) {
      h.leaves[k].lastOutputAt = 100 + k
      h.deliverAll()
    }
    expect({
      revision: h.senders.publisher.current().revision,
      store: useAppStore.getState().agentSenderPublicationsByHost,
      index: agentSenderIndexWorkForTest(),
      aliases: agentSenderAliasWorkForTest(),
      rows: h.rowsSent(),
      renders,
      otherRenders
    }).toEqual(settled)

    // One real change publishes once; its duplicate on the other transport changes nothing again.
    h.open(n, 'w2')
    act(() => h.applyGraph(h.graphReply()))
    const published = useAppStore.getState().agentSenderPublicationsByHost
    expect(h.senders.publisher.current().revision?.revision).toBe(
      (settled.revision?.revision ?? 0) + 1
    )
    expect(located(n)).toBe(`tab${n}:${leafOf(n)}`)
    act(() => {
      h.applyFrame(h.frame('w2'))
      h.applyFrame(h.frame('w1'))
    })
    expect(useAppStore.getState().agentSenderPublicationsByHost).toBe(published)
    expect(otherRenders).toBe(settled.otherRenders)
  }
)

it('keeps a newer worktree scope over a delayed whole-host reply, in either order', () => {
  const h = host(4)
  h.deliverAll()
  // A whole-host reply with rows is cut, then delayed past a newer change to w1.
  h.open(4, 'w1')
  const delayed = h.graphReply()
  expect(delayed.agentSenderAssociations?.associations).toHaveLength(5)
  h.open(6, 'w1')
  act(() => h.applyFrame(h.frame('w1')))
  act(() => h.applyGraph(delayed))
  expect(located(6)).toBe(`tab6:${leafOf(6)}`)
  expect(located(4)).toBe(`tab4:${leafOf(4)}`)
  expect(located(1)).toBe(`tab1:${leafOf(1)}`)
  // Reverse: the whole-host reply first, then the same change's scope, which adds nothing.
  h.open(5, 'w2')
  act(() => h.applyGraph(h.graphReply()))
  const applied = useAppStore.getState().agentSenderPublicationsByHost
  act(() => h.applyFrame(h.frame('w2')))
  expect(useAppStore.getState().agentSenderPublicationsByHost).toBe(applied)
  expect(located(5)).toBe(`tab5:${leafOf(5)}`)
})

it('sends complete sender data to a reconnected stream, a second window and a replaced runtime', () => {
  const h = host(4)
  h.deliverAll()
  const before = h.rowsSent()
  expect(h.frame('w1').agentSenderAssociations).toBeUndefined()
  h.reconnect()
  expect(h.frame('w1').agentSenderAssociations?.associations).toHaveLength(2)
  // A window that applied nothing yet sends no base.
  expect(h.senders.buildForGraph(undefined).agentSenderAssociations?.associations).toHaveLength(4)
  h.replaceRuntime()
  h.reconnect()
  act(() => {
    h.applyGraph(h.graphReply())
    h.applyFrame(h.frame('w1'))
  })
  expect(h.rowsSent()).toBe(before + 4 + 2)
  expect(useAppStore.getState().agentSenderPublicationsByHost.local['*'].revision?.epoch).toBe(
    h.senders.publisher.epoch
  )
  expect(located(3)).toBe(`tab3:${leafOf(3)}`)
})
