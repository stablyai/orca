import { describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { browserImportStateForHostUpdate } from './browser/browser-host-state'
import { mutateDiffComments } from './diff-comment-persistence'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createTabsSliceMockApi()

describe('empty store updates', () => {
  it('does not notify for missing tab actions', () => {
    const store = createTestStore()
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    before.setTabLabel('missing', 'label')
    before.setTabCustomLabel('missing', 'label')
    before.setUnifiedTabColor('missing', null)
    before.setTabViewMode('missing', 'chat')
    before.toggleTabViewMode('missing')
    before.pinTab('missing')
    before.unpinTab('missing')
    before.reorderUnifiedTabs('missing', [])
    before.moveUnifiedTabToGroup('missing', 'missing')

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not notify for unchanged labels but publishes changed labels', () => {
    const store = createTestStore()
    const tab = store
      .getState()
      .createUnifiedTab('folder-workspace', 'terminal', { label: 'label' })
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    before.setTabLabel(tab.id, 'label')
    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()

    before.setTabLabel(tab.id, 'new label')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().getTab(tab.id)?.label).toBe('new label')
  })

  it('does not notify for rejected generation updates or empty pruning', () => {
    const store = createTestStore()
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    before.updateCommitMessageGenerationRecord('missing', () => null)
    before.updatePullRequestGenerationRecord('missing', () => null)
    before.pruneCommitMessageGenerationRecords(new Set())
    before.prunePullRequestGenerationRecords(new Set())

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not notify for absent Jira issues, browser pages or diff comments', () => {
    const store = createTestStore()
    const before = store.getState()
    const listener = vi.fn()
    store.subscribe(listener)

    before.patchJiraIssue('MISSING-1', {})
    before.patchLinearIssue('missing', {})
    before.switchBrowserTabProfile('missing', null, 'persist:missing')
    before.recordClientHostedBrowserCloseIntents([])
    before.clearClientHostedBrowserCloseIntents('missing', [])
    mutateDiffComments(store.setState, 'missing', () => null)
    store.setState((state) => browserImportStateForHostUpdate(state, 'runtime:other', null))

    expect(store.getState()).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })
})
