import { describe, expect, it, vi } from 'vitest'
import {
  readConversationKnowledgeViewMode,
  writeConversationKnowledgeViewMode
} from './conversation-knowledge-view-mode'

describe('conversation knowledge view mode', () => {
  it.each([
    ['project', 'project'],
    ['all', 'all'],
    ['unexpected', 'all'],
    [null, 'all']
  ] as const)('reads %s as %s', (stored, expected) => {
    expect(readConversationKnowledgeViewMode({ getItem: () => stored })).toBe(expected)
  })

  it('persists the selected mode', () => {
    const setItem = vi.fn()

    writeConversationKnowledgeViewMode({ setItem }, 'project')

    expect(setItem).toHaveBeenCalledWith('orca:conversation-knowledge:view-mode', 'project')
  })
})
