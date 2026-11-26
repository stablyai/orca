import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { layoutHoldsOnlyOverlayViews } from './released-layout-eligibility'
import { markQuickCommandEditorOpen } from '../../tab-bar/quick-commands/quick-command-editor-presence'

const worktreeId = 'repo::/work/wt-1'
const terminalTab: Tab = {
  id: 'tab-1',
  entityId: 'tab-1',
  groupId: 'group-1',
  worktreeId,
  contentType: 'terminal',
  label: 'zsh',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0
}
const groups: TabGroup[] = [
  { id: 'group-1', worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
]

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('releasing a parked workspace layout', () => {
  it('keeps the layout while a quick-command dialog with unsaved text is open in it', () => {
    useAppStore.setState({ unifiedTabsByWorktree: { [worktreeId]: [terminalTab] } })
    expect(layoutHoldsOnlyOverlayViews(worktreeId, groups)).toBe(true)

    const close = markQuickCommandEditorOpen(worktreeId)
    expect(layoutHoldsOnlyOverlayViews(worktreeId, groups)).toBe(false)

    close()
    expect(layoutHoldsOnlyOverlayViews(worktreeId, groups)).toBe(true)
  })
})
