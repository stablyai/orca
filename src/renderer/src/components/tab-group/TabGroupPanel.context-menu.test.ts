import { describe, expect, it } from 'vitest'
import type { Tab, TabContentType } from '../../../../shared/tab-types'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'

function tab(id: string, entityId: string, contentType: TabContentType, sortOrder: number): Tab {
  return {
    id,
    entityId,
    contentType,
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  }
}

describe('TabGroupPanel context menu id resolution', () => {
  const groupTabs = [
    tab('unified-terminal-1', 'terminal-entity-1', 'terminal', 0),
    tab('unified-editor-1', 'editor-entity-1', 'editor', 1),
    tab('unified-browser-1', 'browser-entity-1', 'browser', 2)
  ]

  it('resolves terminal and browser entity ids to their unified tab ids', () => {
    // Translate terminal/browser entity IDs into the unified IDs required by group close actions.
    expect(resolveGroupTabFromVisibleId(groupTabs, 'terminal-entity-1')?.id).toBe(
      'unified-terminal-1'
    )
    expect(resolveGroupTabFromVisibleId(groupTabs, 'browser-entity-1')?.id).toBe(
      'unified-browser-1'
    )
  })

  it('resolves editor unified tab ids without falling back to the file entity id only', () => {
    // Editor menus identify split copies by unified ID because file entity IDs are shared.
    expect(resolveGroupTabFromVisibleId(groupTabs, 'unified-editor-1')?.id).toBe('unified-editor-1')
  })

  it('returns null for ids that are not visible in the group', () => {
    expect(resolveGroupTabFromVisibleId(groupTabs, 'missing-id')).toBeNull()
  })
})
