import { describe, expect, it } from 'vitest'
import {
  createHandoffPageId,
  encodeHandoffBody,
  handoffPrompt,
  isHandoffPage,
  readHandoff
} from './goal-handoff'

const page = {
  pageId: createHandoffPageId(),
  kind: 'note' as const,
  title: 'Fix the build',
  body: '',
  deleted: false
}

describe('Commander Markdown handoffs', () => {
  it('round-trips embedded headings and escapes in either field', () => {
    for (const content of [
      '',
      '## Next step',
      '\\## Next step',
      'a\n\n## Next step\n\nb',
      '# Details\n\n- a\n- b'
    ]) {
      const fields = { goal: page.title, progress: content, nextStep: content }
      expect(readHandoff({ ...page, body: encodeHandoffBody(fields) })).toEqual(fields)
    }
  })
  it('filters deleted or unrelated pages and rejects malformed or ambiguous Markdown', () => {
    expect(isHandoffPage({ ...page, deleted: true })).toBe(false)
    expect(isHandoffPage({ ...page, kind: 'decision' })).toBe(false)
    expect(isHandoffPage({ ...page, pageId: 'handoff-my-notes' })).toBe(false)
    const body = encodeHandoffBody({ progress: 'Tests pass', nextStep: 'Ship' })
    expect(readHandoff({ ...page, body: `${body}\n\n## Next step\n\nagain` })).toBeNull()
    expect(readHandoff({ ...page, body, title: ' ' })).toBeNull()
    expect(readHandoff({ ...page, body: body + 'x'.repeat(4001) })).toBeNull()
    expect(readHandoff(page)).toBeNull()
  })
  it('names the saved revision and project in the continuation', () => {
    const actor = { type: 'human' as const, id: 'owner' }
    const text = handoffPrompt({
      ...page,
      body: encodeHandoffBody({ progress: 'Built', nextStep: 'Test' }),
      projectId: 'api',
      version: 2,
      createdAt: 'now',
      actor,
      createdBy: actor,
      links: []
    })
    for (const snippet of ['Fix the build', 'Project: api', 'Built', 'Test', `${page.pageId} v2`]) {
      expect(text).toContain(snippet)
    }
  })
})
