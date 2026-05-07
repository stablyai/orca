import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createLayoutRulesSlice } from './layout-rules'

const WT = 'repo1::/tmp/wt'
const minimalConfig = {
  groups: { editor: { position: 'left-top' as const } }
}

function createTestStore() {
  return create<AppState>()(
    (set, get, api) =>
      ({
        ...createLayoutRulesSlice(set, get, api),
        // The slice updates groupsByWorktree to drop layoutGroupName stamps
        // when a config is replaced; provide a minimal sibling state.
        groupsByWorktree: {}
      }) as AppState
  )
}

describe('createLayoutRulesSlice', () => {
  it('records a binding and stamps the matching TabGroup with name + kind', () => {
    const store = createTestStore()
    store.setState({
      groupsByWorktree: {
        [WT]: [{ id: 'g0', worktreeId: WT, activeTabId: null, tabOrder: [] }]
      }
    })
    // Kind stamping requires the config to be in store first (so the
    // binding action knows which kind to copy from the YAML group).
    store.getState().setLayoutConfigForWorktree(WT, {
      groups: { editor: { position: 'left-top', kind: 'editor' } }
    })
    store.getState().recordLayoutGroupBinding(WT, 'editor', 'g0')
    const s = store.getState()
    expect(s.layoutGroupIdByName[WT]).toEqual({ editor: 'g0' })
    expect(s.groupsByWorktree[WT][0].kind).toBe('editor')
    expect(s.groupsByWorktree[WT][0].layoutGroupName).toBe('editor')
  })

  it('preserves bindings when the same-shape config is re-pushed (boot rebuild → prefetch round-trip)', () => {
    const store = createTestStore()
    store.setState({
      groupsByWorktree: {
        [WT]: [
          { id: 'g0', worktreeId: WT, activeTabId: null, tabOrder: [], layoutGroupName: 'editor' }
        ]
      }
    })
    store.getState().setLayoutConfigForWorktree(WT, minimalConfig)
    store.getState().rebuildLayoutBindingsFromGroups(WT, [{ id: 'g0', layoutGroupName: 'editor' }])
    expect(store.getState().layoutGroupIdByName[WT]).toEqual({ editor: 'g0' })

    // Prefetch round-trip arrives with structurally identical config.
    // Bindings rebuilt from persisted stamps must survive.
    store.getState().setLayoutConfigForWorktree(WT, minimalConfig)
    expect(store.getState().layoutGroupIdByName[WT]).toEqual({ editor: 'g0' })
    expect(store.getState().groupsByWorktree[WT][0].layoutGroupName).toBe('editor')
  })

  it('clears kind stamps on split-derived groups (no layoutGroupName) when config is removed', () => {
    // Why: split-derived siblings carry only `kind` — the cleanup
    // must catch them too, otherwise removing orca.yaml leaves
    // orphan kind-locked panes alive forever.
    const store = createTestStore()
    store.setState({
      groupsByWorktree: {
        [WT]: [
          // Split sibling: kind only, no layoutGroupName.
          { id: 'g-split', worktreeId: WT, activeTabId: null, tabOrder: [], kind: 'browser' }
        ]
      }
    })
    store.getState().setLayoutConfigForWorktree(WT, minimalConfig)
    // Now remove the config — the kind stamp must be cleared.
    store.getState().setLayoutConfigForWorktree(WT, null)
    const s = store.getState()
    expect(s.groupsByWorktree[WT][0].kind).toBeUndefined()
  })

  it('clears bindings AND drops layoutGroupName stamps when config is set to null', () => {
    const store = createTestStore()
    store.setState({
      groupsByWorktree: {
        [WT]: [
          { id: 'g0', worktreeId: WT, activeTabId: null, tabOrder: [], layoutGroupName: 'editor' }
        ]
      }
    })
    store.getState().setLayoutConfigForWorktree(WT, minimalConfig)
    store.getState().recordLayoutGroupBinding(WT, 'editor', 'g0')

    store.getState().setLayoutConfigForWorktree(WT, null)
    const s = store.getState()
    expect(s.layoutConfigByWorktree[WT]).toBeUndefined()
    expect(s.layoutGroupIdByName[WT]).toBeUndefined()
    expect(s.groupsByWorktree[WT][0].layoutGroupName).toBeUndefined()
  })

  it('drops stale bindings when a config is replaced (rename safety)', () => {
    const store = createTestStore()
    store.setState({
      groupsByWorktree: {
        [WT]: [{ id: 'g0', worktreeId: WT, activeTabId: null, tabOrder: [] }]
      }
    })
    store.getState().setLayoutConfigForWorktree(WT, minimalConfig)
    store.getState().recordLayoutGroupBinding(WT, 'editor', 'g0')

    // User renamed `editor` to `code` in orca.yaml. Prefetch fires with
    // the new config — old binding `editor → g0` must be dropped.
    store.getState().setLayoutConfigForWorktree(WT, {
      groups: { code: { position: 'left-top' } }
    })
    const s = store.getState()
    expect(s.layoutGroupIdByName[WT]).toBeUndefined()
    // The TabGroup's stale layoutGroupName stamp must also be cleared
    // so post-restart hydration doesn't resurrect the old name.
    expect(s.groupsByWorktree[WT][0].layoutGroupName).toBeUndefined()
  })

  it('ensureGroup allows-predicate skips kind-locked groups in fallback path', async () => {
    // When every existing group is kind-locked to a non-matching content,
    // ensureGroup must NOT silently fall back to one of them — it should
    // create a fresh mixed-kind group instead. Without this, a CLI
    // new-terminal in a worktree whose only declared group is `kind: editor`
    // strands the terminal in the editor group via the fallback path.
    const { ensureGroup } = await import('./tab-group-state')
    const worktreeId = WT
    const groupsByWorktree = {
      [worktreeId]: [
        { id: 'gE', worktreeId, activeTabId: null, tabOrder: [], layoutGroupName: 'editor' }
      ]
    }
    const allowsTerminal = (groupId: string): boolean => groupId !== 'gE'
    const result = ensureGroup(
      groupsByWorktree,
      { [worktreeId]: 'gE' },
      worktreeId,
      'gE',
      allowsTerminal
    )
    expect(result.group.id).not.toBe('gE')
    expect(result.groupsByWorktree[worktreeId]).toHaveLength(2)
  })

  it('rebuildLayoutBindingsFromGroups recovers names from persisted TabGroup stamps', () => {
    const store = createTestStore()
    store.getState().rebuildLayoutBindingsFromGroups(WT, [
      { id: 'g0', layoutGroupName: 'editor' },
      { id: 'g1', layoutGroupName: 'terminal' },
      { id: 'g2' } // no stamp
    ])
    expect(store.getState().layoutGroupIdByName[WT]).toEqual({
      editor: 'g0',
      terminal: 'g1'
    })
  })
})
