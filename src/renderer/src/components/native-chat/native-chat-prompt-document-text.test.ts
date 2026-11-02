import { expect, it } from 'vitest'
import { withNativeChatComposerDraftAddition } from './native-chat-composer-draft-addition'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'

it.each(['spaces', 'hard breaks', 'empty paragraphs'])(
  'trims trailing %s while keeping picked skills and earlier paragraphs',
  (trailing) => {
    const first = { type: 'paragraph', content: [{ type: 'text', text: 'first' }] }
    const picked = { type: 'nativeChatSkill', attrs: { token: '$review' } }
    const draft: NativeChatComposerDraft = {
      text: `first\n$review${trailing === 'spaces' ? '  ' : '\n\n'}`,
      images: [],
      document: {
        type: 'doc',
        content: [
          first,
          {
            type: 'paragraph',
            content: [
              picked,
              ...(trailing === 'spaces'
                ? [{ type: 'text', text: '  ' }]
                : trailing === 'hard breaks'
                  ? [{ type: 'hardBreak' }, { type: 'hardBreak' }]
                  : [])
            ]
          },
          ...(trailing === 'empty paragraphs'
            ? [
                { type: 'paragraph', content: [] },
                { type: 'paragraph', content: [] }
              ]
            : [])
        ]
      }
    }
    const result = withNativeChatComposerDraftAddition(draft, { text: 'go' })
    expect(result.text).toBe('first\n$review\n\ngo')
    expect(result.document?.content).toEqual([
      first,
      { type: 'paragraph', content: [picked] },
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: 'go' }] }
    ])
  }
)

it('replaces an all-whitespace document with literal returned text', () => {
  const result = withNativeChatComposerDraftAddition(
    {
      text: ' \n',
      images: [],
      document: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: ' ' }] },
          { type: 'paragraph', content: [] }
        ]
      }
    },
    { text: '$review' }
  )
  expect(result.document?.content).toEqual([
    { type: 'paragraph', content: [{ type: 'text', text: '$review' }] }
  ])
})
