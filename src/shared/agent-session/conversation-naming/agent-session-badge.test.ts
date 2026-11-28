import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_BADGE_ICON_MAX_LENGTH, readAgentSessionBadge } from './agent-session-badge'
import { foldAgentSessionConversationNames } from './agent-session-conversation-names'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('readAgentSessionBadge', () => {
  it.each([
    ['a remote URL', { label: 'Blender', icon: 'https://example.com/logo.png' }],
    ['a script URL', { label: 'Blender', icon: 'javascript:alert(1)' }],
    ['an HTML data URL', { label: 'Blender', icon: 'data:text/html;base64,PGI+' }],
    [
      'a picture over the limit',
      {
        label: 'Blender',
        icon: `data:image/png;base64,${'A'.repeat(AGENT_SESSION_BADGE_ICON_MAX_LENGTH)}`
      }
    ],
    ['an invisible label', { label: ' \u200B ', icon: PNG }],
    ['a label over 64 characters', { label: 'x'.repeat(65), icon: PNG }]
  ])('refuses %s', (_case, value) => {
    expect(readAgentSessionBadge(value)).toBeUndefined()
  })

  it('keeps a small picture with its trimmed label', () => {
    expect(readAgentSessionBadge({ label: ' Linked to Blender ', icon: PNG })).toEqual({
      label: 'Linked to Blender',
      icon: PNG
    })
  })
})

describe('badges from a host', () => {
  const note = (badge?: unknown) => ({
    sessionId: 'chat-1',
    conversationName: 'Wall review',
    forkedFrom: null,
    ...(badge === undefined ? {} : { badge })
  })
  const fold = (names: ReturnType<typeof foldAgentSessionConversationNames>, frame: object) =>
    foldAgentSessionConversationNames(names, {
      type: 'snapshot',
      sessions: [],
      conversationNames: [frame as never]
    })

  it('never keeps a badge a host sends with an unsafe picture', () => {
    const names = fold(new Map(), note({ label: 'Blender', icon: 'https://example.com/a.png' }))
    expect(names.get('chat-1')?.conversationName).toBe('Wall review')
    expect(names.get('chat-1')).not.toHaveProperty('badge')
  })
})
