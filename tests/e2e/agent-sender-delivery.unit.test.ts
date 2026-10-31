// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { createRuntimeAgentProjections } from '../../src/main/runtime/construction/runtime-agent-projections'
import { createSessionTabsStreamDelta } from '../../src/main/runtime/rpc/methods/session-tabs-sender-delta'
import { MIRROR_LEAVES_STEP_1 } from '../../src/main/runtime/runtime-leaf-record-projection.test-fixture'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../src/main/runtime/runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import type { RuntimeSyncWindowGraphResult } from '../../src/shared/runtime-session-contracts'

/** The sender part of a window graph reply, as main sends it. */
type SenderGraphReply = Pick<
  RuntimeSyncWindowGraphResult,
  'agentSenderAssociations' | 'agentSenderRevision'
>
import {
  agentSenderIndexWorkForTest,
  selectAgentSenderAssociation
} from '@/runtime/agent-sender-associations'
import { agentSenderAliasWorkForTest } from '@/runtime/agent-sender-alias-projection'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { handleGlobalSessionEvent } from '@/runtime/web-session-tabs-sync/global-session-events'
import { VisibilityResumeCoordinator } from '@/runtime/web-session-tabs-sync/visibility-resume-coordinator'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { useAgentMessageSenderView } from '@/components/native-chat/native-chat-agent-message-sender-view'
import {
  initialStore,
  resetSenderStore
} from '@/components/native-chat/native-chat-agent-sender.test-fixture'
import { makeTab } from '@/store/slices/store-test-helpers'

beforeEach(() => {
  resetSenderStore()
  resetWebSessionTabsSnapshotFreshnessForTests()
  resetLocalStructuredSessionVersionForTests()
})
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
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  let rowsSent = 0
  const count = (publication: { associations: readonly unknown[] } | undefined) => {
    rowsSent += publication?.associations.length ?? 0
  }
  /** The window's graph sync: it sends the revision it applied, and applies only rows. */
  const graphReply = () => {
    const base = useAppStore.getState().agentSenderPublicationsByHost.local?.['*']?.revision
    return wire<SenderGraphReply>(senders.buildForGraph(base))
  }
  const applyGraph = (result: SenderGraphReply) => {
    count(result.agentSenderAssociations)
    if (!result.agentSenderRevision) {
      useAppStore.getState().setAgentSenderPublication('local', result.agentSenderAssociations)
    }
  }
  let stream = createSessionTabsStreamDelta(undefined)
  let version = 0
  /** One session-tab stream frame for a worktree, through that stream's encoder and the wire;
   *  a host re-emit repeats the tab version the window already has. */
  const frame = (worktree: string, snapshotVersion = ++version) =>
    wire<RuntimeMobileSessionTabsResult>(
      stream({
        worktree,
        publicationEpoch: 'host',
        snapshotVersion,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [],
        agentSenderAssociations: senders.buildForFrame(worktree)
      })
    )
  /** The window's local receipt path, with its version, placeholder and frames-draw checks. */
  const applyFrame = (snapshot: RuntimeMobileSessionTabsResult, framesDraw = false) => {
    count(snapshot.agentSenderAssociations)
    applyStructuredSessionTabSnapshots([snapshot], undefined, { framesDraw: () => framesDraw })
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
    version: () => version,
    reconnect: () => {
      stream = createSessionTabsStreamDelta(undefined)
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
      attachments: [],
      revision: { epoch: 'far', revision: 1 }
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
    // This window's own terminal tabs, split over two worktrees, feed the sender aliases.
    const windowTabs = (bucket: string) =>
      Array.from({ length: n / 2 }, (_, i) =>
        makeTab({ id: `${bucket}-tab-${i}::${leafOf(i)}`, worktreeId: bucket })
      )
    useAppStore.setState({ tabsByWorktree: { w1: windowTabs('w1'), w2: windowTabs('w2') } })
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
    // Status and title changes, and repeats, alternating both transports; and this window's
    // unrelated writes, a switch between other workspaces and a settings write.
    for (let k = 0; k < 5; k++) {
      h.leaves[k].lastOutputAt = 100 + k
      h.deliverAll()
      act(() =>
        useAppStore.setState((state) => ({
          sidebarBody: k % 2 ? 'agents' : 'files',
          activeWorktreeId: `elsewhere-${k}`,
          settings: state.settings ? { ...state.settings } : state.settings
        }))
      )
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
    // A title-only change rescans that one bucket and rebuilds no index.
    act(() =>
      useAppStore.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          w1: state.tabsByWorktree.w1.map((tab, i) => (i ? tab : { ...tab, title: 'renamed' }))
        }
      }))
    )
    act(() => h.applyGraph(h.graphReply()))
    expect(agentSenderAliasWorkForTest()).toBe(settled.aliases + n / 2)
    expect(agentSenderIndexWorkForTest()).toEqual(settled.index)
    expect(renders).toBe(settled.renders)

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

it('applies a sender scope whose local frame the tab checks drop, and keeps it when later frames omit it', () => {
  const h = host(2)
  h.deliverAll()
  // A host re-emit at the tab version the window already applied carries the new terminal.
  h.open(2, 'w1')
  act(() => h.applyFrame(h.frame('w1', h.version())))
  expect(located(2)).toBe(`tab2:${leafOf(2)}`)
  expect(h.frame('w1').agentSenderAssociations).toBeUndefined()
  // A workspace main's frames draw drops the tab patch; the sender scope still applies.
  h.open(4, 'w1')
  act(() => h.applyFrame(h.frame('w1'), true))
  expect(located(4)).toBe(`tab4:${leafOf(4)}`)
})

const PAIRED = 'paired'
const pairedLocated = (i: number) =>
  selectAgentSenderAssociation(useAppStore.getState(), `runtime:${PAIRED}`, sender(i))?.paneKey

/** A paired host's frames through the window's real stream handler: runtime fence, receipt
 *  order, the retired-lineage and resume-census checks, then the tab version gate. */
function pairedWindow() {
  const coordinator = new VisibilityResumeCoordinator({
    environments: [],
    environmentIdBySubscriptionSpec: [],
    omissions: new Map(),
    activeRuntimeWorktreeKey: () => null
  })
  const receive = (event: unknown, runtimeId = 'rt-1', resume = false) =>
    act(() =>
      handleGlobalSessionEvent({
        environmentId: PAIRED,
        expectedEnvironmentConnectionGeneration: 0,
        expectedTrackingGeneration: 0,
        visibilityGeneration: resume ? 1 : 0,
        isCurrent: () => true,
        event,
        response: { id: 'stream', ok: true, result: event, _meta: { runtimeId } },
        awaitingVisibilityResumeInventory: { value: resume },
        coordinator
      })
    )
  return {
    frame: (snapshot: RuntimeMobileSessionTabsResult, runtimeId?: string) =>
      receive({ ...snapshot, type: 'updated' }, runtimeId),
    census: (snapshots: RuntimeMobileSessionTabsResult[]) =>
      receive({ type: 'snapshots', snapshots }, 'rt-1', true)
  }
}

it('applies a paired host scope its tab gates drop: same-version re-emit, then later frames that omit it', () => {
  const h = host(2)
  const w = pairedWindow()
  w.frame(h.frame('w1'))
  expect(pairedLocated(0)).toBe(`tab0:${leafOf(0)}`)
  h.open(2, 'w1')
  const reemit = h.frame('w1', h.version())
  expect(reemit.agentSenderAssociations?.associations).toHaveLength(2)
  w.frame(reemit)
  const later = h.frame('w1')
  expect(later.agentSenderAssociations).toBeUndefined()
  w.frame(later)
  expect(pairedLocated(2)).toBe(`tab2:${leafOf(2)}`)
  // A resume census at unchanged versions skips its tab work, not its sender scopes.
  h.reconnect()
  h.open(4, 'w1')
  w.census([h.frame('w1', h.version()), h.frame('w2', h.version())])
  expect(pairedLocated(4)).toBe(`tab4:${leafOf(4)}`)
  expect(pairedLocated(1)).toBe(`tab1:${leafOf(1)}`)
})

it('never lets an older paired scope or a superseded runtime replace a newer one', () => {
  const h = host(2)
  const w = pairedWindow()
  w.frame(h.frame('w1'))
  // A one-shot list cut before the change arrives after the stream delivered it.
  h.reconnect()
  const delayed = h.frame('w1')
  h.open(2, 'w1')
  w.frame(h.frame('w1'))
  const applied = useAppStore.getState().agentSenderPublicationsByHost
  w.frame(delayed)
  expect(useAppStore.getState().agentSenderPublicationsByHost).toBe(applied)
  expect(pairedLocated(2)).toBe(`tab2:${leafOf(2)}`)
  // The host restarts: the new runtime's scope replaces the old epoch, and the old runtime's
  // straggler changes nothing.
  const straggler = h.frame('w1')
  h.replaceRuntime()
  h.reconnect()
  h.leaves.splice(2, 1)
  w.frame(h.frame('w1'), 'rt-2')
  expect(pairedLocated(2)).toBeUndefined()
  const restarted = useAppStore.getState().agentSenderPublicationsByHost
  w.frame({ ...straggler, agentSenderAssociations: delayed.agentSenderAssociations }, 'rt-1')
  expect(useAppStore.getState().agentSenderPublicationsByHost).toBe(restarted)
})
