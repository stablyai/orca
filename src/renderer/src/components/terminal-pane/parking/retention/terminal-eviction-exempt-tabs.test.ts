import { expect, it, onTestFinished } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { holdPaneResumeInPlace } from '../../session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { selectEvictionExemptTerminalTabIds } from './terminal-eviction-exempt-tabs'

const worktreeId = 'repo::/work/wt-1'
const leafId = '11111111-1111-4111-8111-111111111111'
const claudePtyId = `${worktreeId}@@a1`
const layout = {
  root: { type: 'leaf' as const, leafId },
  activeLeafId: leafId,
  expandedLeafId: null
}

function forceParkExemptTabIds(): ReadonlySet<string> {
  return selectEvictionExemptTerminalTabIds(
    worktreeId,
    useAppStore.getState().tabsByWorktree[worktreeId] ?? []
  )
}

it('keeps a force-parked tab mounted only while its pane has a start in flight', () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: claudePtyId })] },
    terminalLayoutsByTabId: { 'tab-1': { ...layout, ptyIdsByLeafId: { [leafId]: claudePtyId } } }
  })
  expect(forceParkExemptTabIds()).toEqual(new Set(['tab-1']))

  const release = holdPaneResumeInPlace(makePaneKey('tab-1', leafId), () => true)
  onTestFinished(release)
  useAppStore.getState().clearTabPtyId('tab-1', claudePtyId)
  useAppStore.getState().setTabLayout('tab-1', layout)
  expect(forceParkExemptTabIds()).toEqual(new Set(['tab-1']))

  release()
  expect(forceParkExemptTabIds()).toEqual(new Set())
})
