import type { AppState } from '../types'
import { describe, expect, it } from 'vitest'
import { subscribeTerminalParkingInputs } from '@/components/terminal-pane/parking/terminal-parking-input-events'
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'
import { installTerminalParkingInputs } from './terminal-parking-input-transitions'
import {
  buildTerminalTabRetirementPlan,
  hasTerminalPtyOwnerOutsidePane
} from './terminal-tab-retirement'
import { replaceRecordEntries, replaceTabBuckets } from '../keyed-record-transitions'

describe('live retirement ownership', () => {
  it('follows a legacy holder through routing, hints and unified-only restoration', () => {
    const store = createTestStore()
    const a = makeWorktree({ id: 'wt-a', repoId: 'repo', hostId: 'runtime:a' })
    const b = makeWorktree({ id: 'wt-b', repoId: 'repo', hostId: 'runtime:b' })
    seedStore(store, {
      worktreesByRepo: { repo: [a, b] },
      tabsByWorktree: {
        'wt-a': [makeTab({ id: 'closing', worktreeId: 'wt-a', ptyId: 'remote:a@@same' })],
        'wt-b': [makeTab({ id: 'holder', worktreeId: 'wt-b', ptyId: 'remote:same' })]
      }
    })
    const dispose = installTerminalParkingInputs(store)
    try {
      expect(buildTerminalTabRetirementPlan(store.getState(), 'closing').sharedPtyIds).toEqual([])
      store.setState((s) => ({
        worktreesByRepo: replaceRecordEntries(s.worktreesByRepo, [
          ['repo', [a, { ...b, hostId: 'runtime:a' }]]
        ])
      }))
      expect(buildTerminalTabRetirementPlan(store.getState(), 'closing').sharedPtyIds).toEqual([
        'remote:a@@same'
      ])
      store.setState((s) => ({
        tabsByWorktree: replaceTabBuckets<ReturnType<typeof makeTab>>(s.tabsByWorktree, [
          ['wt-b', []]
        ]),
        unifiedTabsByWorktree: replaceTabBuckets<ReturnType<typeof makeUnifiedTab>>(
          s.unifiedTabsByWorktree,
          [
            [
              'wt-b',
              [
                makeUnifiedTab({
                  id: 'wrapper',
                  entityId: 'holder',
                  worktreeId: 'wt-b',
                  groupId: 'group'
                })
              ]
            ]
          ]
        ),
        pendingReconnectPtyIdByTabId: replaceRecordEntries(s.pendingReconnectPtyIdByTabId, [
          ['holder', 'remote:same']
        ])
      }))
      expect(buildTerminalTabRetirementPlan(store.getState(), 'closing').sharedPtyIds).toEqual([
        'remote:a@@same'
      ])
      store.setState((s) => ({
        unifiedTabsByWorktree: replaceTabBuckets<ReturnType<typeof makeUnifiedTab>>(
          s.unifiedTabsByWorktree,
          [['wt-b', []]]
        )
      }))
      expect(buildTerminalTabRetirementPlan(store.getState(), 'closing').runtimeTerminals).toEqual([
        { ptyId: 'remote:a@@same', environmentId: 'a', handle: 'same' }
      ])
    } finally {
      dispose()
    }
  })

  it('allows the last pane to close despite its own hints but protects another leaf', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: { wt: [makeTab({ id: 'tab', worktreeId: 'wt', ptyId: 'remote:a@@same' })] },
      pendingReconnectPtyIdByTabId: { tab: 'remote:a@@same' },
      terminalLayoutsByTabId: {
        tab: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { first: 'remote:a@@same', second: 'remote:a@@other' }
        }
      }
    })
    const dispose = installTerminalParkingInputs(store)
    try {
      expect(
        hasTerminalPtyOwnerOutsidePane(store.getState(), '["runtime","a","same"]', 'tab', 'first')
      ).toBe(false)
      store.setState((s) => ({
        terminalLayoutsByTabId: replaceRecordEntries<AppState['terminalLayoutsByTabId'][string]>(
          s.terminalLayoutsByTabId,
          [
            [
              'tab',
              {
                ...s.terminalLayoutsByTabId.tab,
                ptyIdsByLeafId: { first: 'remote:a@@same', second: 'remote:a@@same' }
              }
            ]
          ]
        )
      }))
      expect(
        hasTerminalPtyOwnerOutsidePane(store.getState(), '["runtime","a","same"]', 'tab', 'first')
      ).toBe(true)
    } finally {
      dispose()
    }
  })

  it('publishes parking changes after an earlier retirement read and reentrant store write', () => {
    const store = createTestStore()
    seedStore(store, {
      tabsByWorktree: {
        wt: [makeTab({ id: 'tab', worktreeId: 'wt', ptyId: 'before' })]
      }
    })
    const captured = store.getState()
    let reading = false
    const stopEarlier = store.subscribe(() => {
      if (reading) {
        return
      }
      reading = true
      buildTerminalTabRetirementPlan(store.getState(), 'tab')
      store.setState((state) => ({ sortEpoch: state.sortEpoch + 1 }))
      reading = false
    })
    const dispose = installTerminalParkingInputs(store)
    let notifiedPtyId: string | null = null
    const stopParking = subscribeTerminalParkingInputs('wt', () => {
      notifiedPtyId = store.getState().tabsByWorktree.wt[0].ptyId
    })
    try {
      store.setState((state) => ({
        tabsByWorktree: replaceTabBuckets<ReturnType<typeof makeTab>>(state.tabsByWorktree, [
          ['wt', [makeTab({ id: 'tab', worktreeId: 'wt', ptyId: 'after' })]]
        ])
      }))
      expect(notifiedPtyId).toBe('after')
      expect(buildTerminalTabRetirementPlan(captured, 'tab').ptyIds).toEqual(['before'])
      expect(buildTerminalTabRetirementPlan(store.getState(), 'tab').ptyIds).toEqual(['after'])
    } finally {
      stopParking()
      dispose()
      stopEarlier()
    }
  })

  it('retains a scoped alias when an unscoped alias moves to another runtime', () => {
    const store = createTestStore()
    const holder = makeWorktree({ id: 'holder-wt', repoId: 'repo', hostId: 'runtime:a' })
    seedStore(store, {
      worktreesByRepo: { repo: [holder] },
      tabsByWorktree: {
        a: [makeTab({ id: 'a', worktreeId: 'a', ptyId: 'remote:a@@same' })],
        b: [makeTab({ id: 'b', worktreeId: 'b', ptyId: 'remote:b@@same' })],
        'holder-wt': [makeTab({ id: 'holder', worktreeId: 'holder-wt', ptyId: null })]
      },
      ptyIdsByTabId: { holder: ['remote:same', 'remote:a@@same'] }
    })
    const dispose = installTerminalParkingInputs(store)
    const plan = (id: string) => buildTerminalTabRetirementPlan(store.getState(), id)
    try {
      expect(plan('a').sharedPtyIds).toEqual(['remote:a@@same'])
      expect(plan('b').sharedPtyIds).toEqual([])
      store.setState((state) => ({
        worktreesByRepo: replaceRecordEntries(state.worktreesByRepo, [
          ['repo', [{ ...holder, hostId: 'runtime:b' }]]
        ])
      }))
      expect(plan('a').sharedPtyIds).toEqual(['remote:a@@same'])
      expect(plan('b').sharedPtyIds).toEqual(['remote:b@@same'])
      store.setState((state) => ({
        ptyIdsByTabId: replaceRecordEntries(state.ptyIdsByTabId, [['holder', ['remote:a@@same']]])
      }))
      expect(plan('a').sharedPtyIds).toEqual(['remote:a@@same'])
      expect(plan('b').sharedPtyIds).toEqual([])
    } finally {
      dispose()
    }
  })
})
