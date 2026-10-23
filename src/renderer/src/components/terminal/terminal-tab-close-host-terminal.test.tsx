// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { makeRuntimeOwnedWorktree, makeWorktree } from '@/store/slices/store-test-helpers'
import { getTerminalPtyOwnershipIdentity } from '@/store/slices/terminal-tab-retirement'
import { isPositivelyLocalSourceWorktree } from '@/lib/terminal-worktree-route'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { terminalPaneHasOtherOwner } from '../terminal-pane/terminal-pane-retirement-ownership'
import {
  ENV,
  HOST,
  LOCAL_PTY,
  PAIRING_REVISION,
  REPO,
  MIRRORED_TAB_ID,
  SERVER,
  SERVER_LEAVES,
  TARGET_WT,
  WT,
  adoptSecondPane,
  applyProductionMirror,
  callsTo,
  clickRenderedX,
  closeOutcome,
  createHostTab,
  expectLocalTerminalUntouched,
  hostTabCloses,
  installTransport,
  observedMirror,
  ptyFor,
  seedClientState,
  transport,
  userFacingLeafPtyIds
} from './terminal-tab-close-host-terminal.test-fixture'

beforeEach(() => {
  installTransport()
  clearRuntimeCompatibilityCacheForTests()
})

afterEach(() => cleanup())

describe('rendered X on a host-stamped adopted terminal', () => {
  const catalogs: [string, () => void][] = [
    ['a valid local source catalog', () => {}],
    // Why: the catalog has not hydrated (#11308): no repo or worktree row names any host.
    [
      'an unresolved source catalog',
      () => useAppStore.setState({ repos: [], worktreesByRepo: {} })
    ],
    [
      'an ambiguous source catalog',
      () =>
        useAppStore.setState({
          repos: [REPO, { ...REPO, id: 'repo2', executionHostId: HOST }],
          worktreesByRepo: {
            repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: REPO.path })],
            repo2: [makeWorktree({ id: WT, repoId: 'repo2', path: REPO.path, hostId: HOST })]
          }
        })
    ]
  ]

  for (const [catalogName, arrangeCatalog] of catalogs) {
    for (const panes of [1, 2] as const) {
      it(`closes each adopted host terminal at its owner with ${panes} pane(s) and ${catalogName}`, async () => {
        seedClientState()
        const localTabId = useAppStore.getState().createTab(WT, undefined, undefined, {
          initialPtyId: LOCAL_PTY
        }).id
        const hostTabId = await createHostTab()
        expect(hostTabId).not.toBe(SERVER.tabId)
        if (panes === 2) {
          adoptSecondPane(hostTabId, ptyFor(SERVER.handles[1]))
        }
        arrangeCatalog()

        await clickRenderedX(hostTabId)

        const expectedHandles = SERVER.handles.slice(0, panes)
        await vi.waitFor(() =>
          expect(callsTo('terminal.close')).toHaveLength(expectedHandles.length)
        )
        expect(callsTo('terminal.close').map((call) => call.params)).toEqual(
          expect.arrayContaining(expectedHandles.map((terminal) => ({ terminal })))
        )
        for (const call of callsTo('terminal.close')) {
          expect(call.selector).toBe(ENV)
          expect(call.expectedEnvironmentPairingRevision).toBe(PAIRING_REVISION)
        }
        expect(hostTabCloses()).toEqual([])
        expect(
          (useAppStore.getState().tabsByWorktree[WT] ?? []).some((tab) => tab.id === hostTabId)
        ).toBe(false)
        expectLocalTerminalUntouched(localTabId)
      })
    }
  }

  // D17 (Prime 09:58:11Z) replaced this case's old expectation (survivor's handle kept): a candidate
  // sharer whose worktree ownership is unresolved is not a sharer, so both per-handle closes proceed.
  it('closes every handle when the only other holder has unresolved worktree ownership', async () => {
    seedClientState()
    const localTabId = useAppStore.getState().createTab(WT, undefined, undefined, {
      initialPtyId: LOCAL_PTY
    }).id
    const hostTabId = await createHostTab()
    adoptSecondPane(hostTabId, ptyFor(SERVER.handles[1]))
    const survivor = useAppStore.getState().createTab(WT)
    useAppStore.getState().updateTabPtyId(survivor.id, ptyFor(SERVER.handles[1]))
    useAppStore.setState({ repos: [], worktreesByRepo: {} })

    await clickRenderedX(hostTabId)

    await vi.waitFor(() => expect(callsTo('terminal.close')).toHaveLength(2))
    expect(callsTo('terminal.close').map((call) => call.params)).toEqual(
      expect.arrayContaining(SERVER.handles.map((terminal) => ({ terminal })))
    )
    expect(hostTabCloses()).toEqual([])
    expectLocalTerminalUntouched(localTabId)
  })

  it('refuses a handle owned by an environment other than the stamp', async () => {
    seedClientState()
    const hostTabId = await createHostTab()
    adoptSecondPane(hostTabId, `remote:env-2@@${SERVER.handles[1]}`)
    useAppStore.setState({ repos: [], worktreesByRepo: {} })

    await clickRenderedX(hostTabId)

    await vi.waitFor(() => expect(callsTo('terminal.close')).toHaveLength(1))
    expect(callsTo('terminal.close')[0]).toMatchObject({
      selector: ENV,
      params: { terminal: SERVER.handles[0] }
    })
    expect(transport.environmentCall.mock.calls.some(([args]) => args.selector === 'env-2')).toBe(
      false
    )
    expect(hostTabCloses()).toEqual([])
  })
})

describe('rendered X on a genuinely remote-owned workspace', () => {
  it('keeps closing the host session tab, not per-handle', async () => {
    seedClientState([makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: REPO.path }, ENV)])
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {
      initialPtyId: ptyFor('term_legacy')
    })

    await clickRenderedX(tab.id)

    await vi.waitFor(() => expect(hostTabCloses()).toHaveLength(1))
    expect(hostTabCloses()[0]).toMatchObject({
      selector: ENV,
      params: { worktree: `id:${WT}`, tabId: tab.id }
    })
    expect(callsTo('terminal.close')).toEqual([])
  })
})

// Why constructed: the historical other owner is UNKNOWN (CHT-3b phase a). The production mirror's
// own row for the target's tab is one concrete passive owner; the fix must hold for any such row.
describe('rendered X with the target tab also mirrored by the production host mirror', () => {
  const expectPassiveMirror = (handles: readonly string[]): void =>
    expect(observedMirror()).toEqual({
      row: true,
      ptyIds: handles.map(ptyFor),
      stamped: false,
      leafIds: SERVER_LEAVES.slice(0, handles.length),
      groupLeafPtyIds: handles.map(ptyFor)
    })
  const expectLocal = (worktreeId: string): void =>
    expect(isPositivelyLocalSourceWorktree(useAppStore.getState(), worktreeId)).toBe(true)
  // Why positive: D17 excludes the mirrored target's leaves because the catalog proves it remote.
  const seedWithRemoteTarget = (): void => {
    seedClientState()
    useAppStore.setState({
      repos: [REPO, { ...REPO, id: 'repo-target', path: '/srv/target', executionHostId: HOST }],
      worktreesByRepo: {
        ...useAppStore.getState().worktreesByRepo,
        'repo-target': [
          makeRuntimeOwnedWorktree(
            { id: TARGET_WT, repoId: 'repo-target', path: '/srv/target', hostId: HOST },
            ENV
          )
        ]
      }
    })
    // Proven by the real resolvers, not by fixture labels.
    expectLocal(WT)
    expect(runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), TARGET_WT)).toBe(ENV)
    expect(isPositivelyLocalSourceWorktree(useAppStore.getState(), TARGET_WT)).toBe(false)
  }
  const closesAt = (handles: readonly string[]) => ({
    sharedPtyIds: [],
    runtimeTerminals: handles.map((handle) => ({ environmentId: ENV, handle })),
    terminalCloses: handles.map((handle) => ({ selector: ENV, handle }))
  })

  for (const panes of [1, 2] as const) {
    it(`closes ${panes} stamped handle(s) at the target despite the mirrored server tab`, async () => {
      seedWithRemoteTarget()
      const localTabId = useAppStore.getState().createTab(WT, undefined, undefined, {
        initialPtyId: LOCAL_PTY
      }).id
      const hostTabId = await createHostTab()
      const handles = SERVER.handles.slice(0, panes)
      if (panes === 2) {
        adoptSecondPane(hostTabId, ptyFor(SERVER.handles[1]))
      }
      applyProductionMirror(handles)
      expectPassiveMirror(handles)
      expect([hostTabId, WT]).not.toContain(MIRRORED_TAB_ID)

      expect(await closeOutcome(hostTabId)).toEqual(closesAt(handles))
      expect(hostTabCloses()).toEqual([])
      expectLocalTerminalUntouched(localTabId)
    })
  }

  it('closes at the target when the mirror lands in a worktree of unresolved ownership', async () => {
    seedClientState()
    expect(
      Object.values(useAppStore.getState().worktreesByRepo)
        .flat()
        .some((row) => row.id === TARGET_WT)
    ).toBe(false)
    const hostTabId = await createHostTab()
    applyProductionMirror([SERVER.handles[0]])
    expectPassiveMirror([SERVER.handles[0]])

    expect(await closeOutcome(hostTabId)).toEqual(closesAt([SERVER.handles[0]]))
  })

  for (const where of ['the source', 'another local'] as const) {
    it(`keeps a handle a LOCAL tab in ${where} worktree still shows, closing only the rest`, async () => {
      seedWithRemoteTarget()
      const otherLocal = makeWorktree({
        id: 'repo1::/client/other',
        repoId: 'repo1',
        path: '/client/other'
      })
      useAppStore.setState({
        worktreesByRepo: {
          ...useAppStore.getState().worktreesByRepo,
          repo1: [...(useAppStore.getState().worktreesByRepo.repo1 ?? []), otherLocal]
        }
      })
      expectLocal(otherLocal.id)
      const hostTabId = await createHostTab()
      adoptSecondPane(hostTabId, ptyFor(SERVER.handles[1]))
      // Why initialPtyId: it binds the survivor's own layout leaf, a pane the user actually sees.
      const survivorWorktree = where === 'the source' ? WT : otherLocal.id
      const survivor = useAppStore.getState().createTab(survivorWorktree, undefined, undefined, {
        initialPtyId: ptyFor(SERVER.handles[1])
      })
      expect(userFacingLeafPtyIds(survivorWorktree, survivor.id)).toEqual([
        ptyFor(SERVER.handles[1])
      ])
      applyProductionMirror(SERVER.handles)

      expect(await closeOutcome(hostTabId)).toEqual({
        sharedPtyIds: [ptyFor(SERVER.handles[1])],
        runtimeTerminals: [{ environmentId: ENV, handle: SERVER.handles[0] }],
        terminalCloses: [{ selector: ENV, handle: SERVER.handles[0] }]
      })
    })
  }

  it('protects a PTY until its last LOCAL pane closes, not while only the mirror holds it', async () => {
    seedWithRemoteTarget()
    const hostTabId = await createHostTab()
    applyProductionMirror([SERVER.handles[0]])
    const pty = ptyFor(SERVER.handles[0])
    const identity = getTerminalPtyOwnershipIdentity(useAppStore.getState(), pty, WT)
    const otherOwnerWithoutPaneOf = (tabId: string) =>
      terminalPaneHasOtherOwner(
        { getState: useAppStore.getState, getTransports: () => new Map(), tabId },
        identity,
        WT,
        Object.keys(useAppStore.getState().terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})[0]
      )
    const lastLocalPane = otherOwnerWithoutPaneOf(hostTabId)
    // Why a second admitted tab: a layout keeps one leaf per PTY (normalizeTerminalLayoutPtyOwnership),
    // so two LOCAL panes showing one PTY are panes of two tabs, not two leaves of one.
    const secondTabId = await createHostTab()
    expect(userFacingLeafPtyIds(WT, secondTabId)).toEqual([pty])

    expect({
      closingFirstOfTwoLocalPanes: otherOwnerWithoutPaneOf(hostTabId),
      closingSecondOfTwoLocalPanes: otherOwnerWithoutPaneOf(secondTabId),
      closingLastLocalPane: lastLocalPane
    }).toEqual({
      closingFirstOfTwoLocalPanes: true,
      closingSecondOfTwoLocalPanes: true,
      closingLastLocalPane: false
    })
    await clickRenderedX(secondTabId)
    cleanup()
    expect(await closeOutcome(hostTabId)).toEqual(closesAt([SERVER.handles[0]]))
  })

  it('never closes at a foreign owner the mirror does not make routable', async () => {
    seedWithRemoteTarget()
    const hostTabId = await createHostTab()
    adoptSecondPane(hostTabId, `remote:env-2@@${SERVER.handles[1]}`)
    applyProductionMirror([SERVER.handles[0]])

    const outcome = await closeOutcome(hostTabId)
    expect(outcome.terminalCloses).toEqual([{ selector: ENV, handle: SERVER.handles[0] }])
    expect(transport.environmentCall.mock.calls.some(([args]) => args.selector === 'env-2')).toBe(
      false
    )
  })

  it('sends nothing for an invalid stamp, mirror or not', async () => {
    seedWithRemoteTarget()
    const hostTabId = await createHostTab()
    applyProductionMirror([SERVER.handles[0]])
    useAppStore.setState({
      unifiedTabsByWorktree: {
        ...useAppStore.getState().unifiedTabsByWorktree,
        [WT]: (useAppStore.getState().unifiedTabsByWorktree[WT] ?? []).map((tab) =>
          tab.entityId === hostTabId ? { ...tab, projectHostSetupId: '' } : tab
        )
      }
    })

    const outcome = await closeOutcome(hostTabId)
    expect(outcome.runtimeTerminals).toEqual([])
    expect(outcome.terminalCloses).toEqual([])
  })

  it('leaves a genuinely remote-owned workspace closing the host session tab, mirror or not', async () => {
    seedClientState([makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: REPO.path }, ENV)])
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {
      initialPtyId: ptyFor('term_legacy')
    })
    applyProductionMirror(['term_legacy'])

    await clickRenderedX(tab.id)

    await vi.waitFor(() => expect(hostTabCloses()).toHaveLength(1))
    expect(callsTo('terminal.close')).toEqual([])
  })
})
