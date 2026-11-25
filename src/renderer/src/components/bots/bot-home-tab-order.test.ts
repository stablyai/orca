import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { displayedTabOrder } from './bot-home-tab-order'
import { storedIndexForDisplayedDrop } from '../tab-group/drag/tab-drop-displayed-order'

function chatTab(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'group',
    worktreeId: 'folder:bot-home',
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const onBotPage = (): { chatSessionId: string } => ({ chatSessionId: 'home-chat' })
const tabs = [chatTab('a', 'a-chat'), chatTab('b', 'b-chat'), chatTab('home', 'home-chat')]

describe('displayedTabOrder', () => {
  it('leads with a Home the stored order misses, as the bar draws it', () => {
    expect(displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', onBotPage)).toEqual([
      'home',
      'a',
      'b'
    ])
  })

  it('lands a tab from another group dropped after that Home before the first tab drawn after it', () => {
    const displayed = displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', onBotPage)
    expect(storedIndexForDisplayedDrop(['a', 'b'], displayed, 'home', 'right')).toBe(0)
  })

  it('moves a stored Home first, and appends unlisted tabs in place off a bot page', () => {
    expect(displayedTabOrder(['a', 'home', 'b'], tabs, 'folder:bot-home', onBotPage)).toEqual([
      'home',
      'a',
      'b'
    ])
    expect(displayedTabOrder(['a', 'b'], tabs, 'folder:bot-home', () => null)).toEqual([
      'a',
      'b',
      'home'
    ])
  })
})
