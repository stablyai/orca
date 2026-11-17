import { describe, expect, it } from 'vitest'

import { queuedMessageWithEdit } from './queued-message-edit'

describe('optional queued edit skills contract', () => {
  it('filters refs by the existing text policy and canonicalizes an empty replacement to absent', () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: '$review this' }],
      skills: [{ name: 'review', path: '/old/SKILL.md' }]
    }
    expect(queuedMessageWithEdit(body, { text: '$review this', skills: [] })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: body.blocks }
    })
    expect(
      queuedMessageWithEdit(body, {
        text: '$review that',
        skills: [
          { name: 'review', path: '/new/SKILL.md' },
          { name: 'missing', path: '/unused/SKILL.md' }
        ]
      })
    ).toMatchObject({ ok: true, body: { skills: [{ name: 'review', path: '/new/SKILL.md' }] } })
    expect(queuedMessageWithEdit(body, { text: '$review this' })).toEqual({ ok: true, body })
    expect(queuedMessageWithEdit(body, { text: 'plain legacy edit' })).toEqual({
      ok: true,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'plain legacy edit' }] }
    })
  })
})
