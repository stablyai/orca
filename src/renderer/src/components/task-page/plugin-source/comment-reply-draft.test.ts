import { describe, expect, it } from 'vitest'

import type { PluginTaskComment } from '../../../../../shared/plugins/plugin-task-source-contract'
import { buildQuotedReplyDraft } from './comment-reply-draft'

function comment(body: string): PluginTaskComment {
  return {
    id: 'c1',
    author: { id: 'u1', displayName: 'Amelia Kato', avatarUrl: null },
    body,
    bodyFormat: 'text',
    createdAt: new Date().toISOString()
  }
}

describe('buildQuotedReplyDraft', () => {
  it('quotes a short body whole, with the attribution', () => {
    const draft = buildQuotedReplyDraft('', comment('Looks good to me.'))

    expect(draft).toBe('> **Amelia Kato wrote:**\n>\n> Looks good to me.\n\n')
  })

  it('truncates a long body with an elision, and keeps the attribution', () => {
    const long = 'x'.repeat(600)

    const draft = buildQuotedReplyDraft('', comment(long))

    expect(draft).toContain('> **Amelia Kato wrote:**')
    const quotedBody = draft.split('\n')[2]
    expect(quotedBody).toBe(`> ${'x'.repeat(400)}…`)
    expect(quotedBody?.length).toBeLessThan(long.length)
  })

  it('appends the quote block below an existing draft instead of replacing it', () => {
    const draft = buildQuotedReplyDraft('Already typed this.', comment('Short reply target.'))

    expect(draft).toBe(
      'Already typed this.\n\n> **Amelia Kato wrote:**\n>\n> Short reply target.\n\n'
    )
  })
})
