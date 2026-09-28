import { describe, expect, it } from 'vitest'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from './agent-row-conversation-name'
import { getKiroNativeTitleSessionText } from './kiro-terminal-title'

const TAB: ConversationNameTab = { customTitle: null, title: '' }

function nameFor(paneLiveTitle: string, tab: Partial<ConversationNameTab> = {}): string | null {
  return getAgentRowConversationName({ ...TAB, ...tab }, 'kiro', true, paneLiveTitle)
}

describe('getKiroNativeTitleSessionText', () => {
  it('returns what follows the marker', () => {
    expect(getKiroNativeTitleSessionText('kiro: Add usage meter')).toBe('Add usage meter')
    expect(getKiroNativeTitleSessionText('host-1 | kiro: Add usage meter')).toBe('Add usage meter')
  })

  it('returns null for a title Kiro did not write', () => {
    expect(getKiroNativeTitleSessionText('fix kiro: parser')).toBeNull()
    expect(getKiroNativeTitleSessionText('')).toBeNull()
  })
})

describe('Kiro agent row conversation name', () => {
  it('names the row with the session title, without the vendor marker', () => {
    expect(nameFor('kiro: Add usage meter to the status bar')).toBe(
      'Add usage meter to the status bar'
    )
  })

  it('does not name the row after the cwd Kiro falls back to', () => {
    expect(nameFor('kiro: ~/code/orca-mods')).toBeNull()
    expect(nameFor('kiro: /Users/me/src')).toBeNull()
  })

  it('lets the generated title win while the session is still unnamed', () => {
    expect(nameFor('kiro: ~/code/orca-mods', { generatedTitle: 'Wire up Kiro usage' })).toBe(
      'Wire up Kiro usage'
    )
  })

  it('keeps a real session title ahead of the generated title, as OpenCode does', () => {
    expect(nameFor('kiro: Fix the v3 usage probe', { generatedTitle: 'Generated' })).toBe(
      'Fix the v3 usage probe'
    )
  })

  it('still lets a manual rename win', () => {
    expect(nameFor('kiro: Fix the v3 usage probe', { customTitle: 'My tab' })).toBe('My tab')
  })
})
