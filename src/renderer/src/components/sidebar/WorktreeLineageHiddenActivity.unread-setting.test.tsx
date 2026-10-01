import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getDefaultNotificationSettings } from '../../../../shared/notification-settings-defaults'
import type * as HiddenActivityModule from './worktree-lineage-hidden-activity'
import {
  LineageHiddenActivityGlyph,
  LineageHiddenActivityTooltipLabel
} from './WorktreeLineageHiddenActivity'

let showChildWorktreeUnread = true

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: createGlobalSettingsFixture({
        notifications: { ...getDefaultNotificationSettings(), showChildWorktreeUnread }
      })
    })
}))

vi.mock('./worktree-lineage-hidden-activity', async (importOriginal) => {
  const original = await importOriginal<typeof HiddenActivityModule>()
  return {
    ...original,
    useLineageHiddenActivity: () => ({
      permission: 1,
      failed: 1,
      working: 1,
      monitoring: 0,
      interrupted: 1
    })
  }
})

const hidden = { worktreeIds: ['child', 'grandchild'], unreadCount: 2 }

function renderGlyph(): string {
  return renderToStaticMarkup(
    <LineageHiddenActivityGlyph hidden={hidden} descriptionId="activity" />
  )
}

describe('collapsed child unread setting', () => {
  beforeEach(() => {
    showChildWorktreeUnread = true
  })

  it('shows the unread overlay and accessible count by default', () => {
    const markup = renderGlyph()
    expect(markup).toContain('data-lineage-hidden-unread')
    expect(markup).toContain('2 unread')
  })

  it('hides unread overlay and count without hiding attention or activity', () => {
    showChildWorktreeUnread = false
    const markup = renderGlyph()
    expect(markup).not.toContain('data-lineage-hidden-unread')
    expect(markup).not.toContain('unread')
    for (const label of ['1 waiting for permission', '1 failed', '1 working', '1 interrupted']) {
      expect(markup).toContain(label)
    }
    expect(
      renderToStaticMarkup(<LineageHiddenActivityTooltipLabel hidden={hidden} />)
    ).not.toContain('unread')
    expect(hidden.unreadCount).toBe(2)
  })
})
