// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { makeRuntimeOwnedWorktree } from '@/store/slices/store-test-helpers'
import { buildTerminalTabRetirementPlan } from '@/store/slices/terminal-tab-retirement'
import { isPositivelyLocalSourceWorktree } from '@/lib/terminal-worktree-route'
import {
  ENV,
  REPO,
  SERVER,
  WT,
  applyProductionMirror,
  callsTo,
  clickRenderedX,
  createHostTab,
  hostTabCloses,
  installTransport,
  observedMirror,
  ptyFor,
  seedClientState,
  userFacingLeafPtyIds
} from './terminal-tab-close-host-terminal.test-fixture'

const SRV_A = SERVER.handles[0]

beforeEach(() => {
  installTransport()
  clearRuntimeCompatibilityCacheForTests()
})

afterEach(() => cleanup())

/** Lets any per-handle close the X started reach the preload boundary before asserting on it. */
async function settledCloses() {
  await vi
    .waitFor(() => expect(callsTo('terminal.close').length).toBeGreaterThan(0), { timeout: 300 })
    .catch(() => {})
  return callsTo('terminal.close').map((call) => ({
    selector: call.selector,
    params: call.params
  }))
}

describe('D17 shared-until-last across two admitted host tabs on one handle', () => {
  it('keeps the handle while a second local host tab shows it, then closes it once at the target', async () => {
    seedClientState()
    // Both admissions get the same host handle back: two real D15 tabs on one PTY.
    const first = await createHostTab()
    const second = await createHostTab()
    applyProductionMirror([SRV_A])
    expect(observedMirror().groupLeafPtyIds).toEqual([ptyFor(SRV_A)])
    expect(isPositivelyLocalSourceWorktree(useAppStore.getState(), WT)).toBe(true)
    expect(userFacingLeafPtyIds(WT, second)).toEqual([ptyFor(SRV_A)])

    await clickRenderedX(first)
    expect(await settledCloses()).toEqual([])
    expect(userFacingLeafPtyIds(WT, second)).toEqual([ptyFor(SRV_A)])

    cleanup()
    await clickRenderedX(second)
    expect(await settledCloses()).toEqual([{ selector: ENV, params: { terminal: SRV_A } }])
    expect(hostTabCloses()).toEqual([])
  })
})

// SYNTHETIC passive fixtures: real local tabs, then the test removes only their user placement or
// adds a stale provider entry. Neither is a pane the user can see on this PTY, so neither may hold
// a host-stamped tab's handle open, whatever kind of worktree owns it.
describe('D17 passive positive-local owners do not suppress a host-stamped close', () => {
  const arrangements: [string, () => string][] = [
    [
      'a local tab whose PTY is indexed but which sits in no tab group',
      () => {
        const passive = useAppStore
          .getState()
          .createTab(WT, undefined, undefined, { initialPtyId: ptyFor(SRV_A) }).id
        useAppStore.setState({
          groupsByWorktree: {
            ...useAppStore.getState().groupsByWorktree,
            [WT]: (useAppStore.getState().groupsByWorktree[WT] ?? []).map((group) => ({
              ...group,
              tabOrder: group.tabOrder.filter((tabId) => tabId !== passive),
              activeTabId: group.activeTabId === passive ? null : group.activeTabId
            }))
          }
        })
        expect(userFacingLeafPtyIds(WT, passive)).toEqual([])
        expect(useAppStore.getState().ptyIdsByTabId[passive]).toEqual([ptyFor(SRV_A)])
        return passive
      }
    ],
    [
      'a visible local tab whose pane shows a different PTY but keeps a stale provider entry',
      () => {
        const visible = useAppStore
          .getState()
          .createTab(WT, undefined, undefined, { initialPtyId: 'pty-local-2' }).id
        useAppStore.setState({
          ptyIdsByTabId: {
            ...useAppStore.getState().ptyIdsByTabId,
            [visible]: ['pty-local-2', ptyFor(SRV_A)]
          }
        })
        expect(userFacingLeafPtyIds(WT, visible)).toEqual(['pty-local-2'])
        return visible
      }
    ]
  ]

  for (const [name, arrange] of arrangements) {
    it(`closes the handle at the target despite ${name}`, async () => {
      seedClientState()
      expect(isPositivelyLocalSourceWorktree(useAppStore.getState(), WT)).toBe(true)
      const hostTabId = await createHostTab()
      arrange()

      await clickRenderedX(hostTabId)
      expect(await settledCloses()).toEqual([{ selector: ENV, params: { terminal: SRV_A } }])
    })
  }
})

describe('non-D15 remote-owned workspace with a mirror', () => {
  it('still plans the mirrored handle as shared and closes through the host session tab', async () => {
    seedClientState([makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1', path: REPO.path }, ENV)])
    const tab = useAppStore.getState().createTab(WT, undefined, undefined, {
      initialPtyId: ptyFor('term_legacy')
    })
    applyProductionMirror(['term_legacy'])

    expect(buildTerminalTabRetirementPlan(useAppStore.getState(), tab.id)).toMatchObject({
      sharedPtyIds: [ptyFor('term_legacy')],
      runtimeTerminals: []
    })
    await clickRenderedX(tab.id)
    await vi.waitFor(() => expect(hostTabCloses()).toHaveLength(1))
    expect(callsTo('terminal.close')).toEqual([])
  })
})
