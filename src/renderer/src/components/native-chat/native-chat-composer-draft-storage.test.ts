import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'
import {
  NativeChatFileReference,
  NativeChatSkill,
  promptSkillRefs,
  promptText,
  promptTextContent
} from './native-chat-prompt-document'

const TEXT = '[Image](orca-image:literal) keep this'
const IMAGES = [{ id: 'remote', path: '/remote/shot.png', connectionId: 'ssh-box' }]
const OWNER = { workspaceId: '/folder', executionHostId: 'ssh:box' }

describe('stored composer documents', () => {
  it.each([undefined, '', null, 42])(
    'falls back to literal text when an image token cannot be recovered: %j',
    (token) => {
      expect(
        parseStoredNativeChatComposerDraft({
          text: TEXT,
          textFormat: 'literal',
          document: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'nativeChatImageReference', attrs: { token } },
                  { type: 'text', text: ' keep this' }
                ]
              }
            ]
          },
          images: IMAGES,
          owner: OWNER,
          savedAt: 1
        })
      ).toEqual({ text: TEXT, textFormat: 'literal', images: IMAGES, owner: OWNER, savedAt: 1 })
    }
  )

  it('keeps a marked plain document and reserved-looking text unchanged', () => {
    const document = promptTextContent(TEXT)
    expect(
      parseStoredNativeChatComposerDraft({
        text: TEXT,
        textFormat: 'literal',
        document,
        images: IMAGES,
        owner: OWNER,
        savedAt: 1
      })
    ).toEqual({
      text: TEXT,
      textFormat: 'literal',
      document,
      images: IMAGES,
      owner: OWNER,
      savedAt: 1
    })
  })

  it.each([false, true])(
    'recovers a literal image token as editable text with rich content %s',
    (rich) => {
      const text = `${TEXT}${rich ? ' @/folder/file.ts $review' : ''}`
      const parsed = parseStoredNativeChatComposerDraft({
        text,
        textFormat: 'literal',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'nativeChatImageReference',
                  attrs: { token: '[Image](orca-image:literal)' }
                },
                { type: 'text', text: ' keep this' },
                ...(rich
                  ? [
                      { type: 'text', text: ' ' },
                      {
                        type: 'nativeChatFileReference',
                        attrs: { token: '@/folder/file.ts', path: '/folder/file.ts' }
                      },
                      { type: 'text', text: ' ' },
                      {
                        type: 'nativeChatSkill',
                        attrs: { token: '$review', path: '/skills/review/SKILL.md' }
                      }
                    ]
                  : [])
              ]
            }
          ]
        },
        images: IMAGES,
        owner: OWNER,
        savedAt: 1
      })
      expect(parsed).toMatchObject({ text, images: IMAGES, owner: OWNER, savedAt: 1 })
      if (!parsed?.document) {
        throw new Error('The editable document was lost')
      }
      const schema = getSchema([StarterKit, NativeChatSkill, NativeChatFileReference])
      const document = schema.nodeFromJSON(parsed.document)
      document.check()
      expect(promptText(document)).toBe(text)
      expect(promptSkillRefs(parsed.document)).toEqual(
        rich ? [{ name: 'review', path: '/skills/review/SKILL.md' }] : []
      )
      if (rich) {
        expect(parsed.document.content?.[0]?.content).toContainEqual({
          type: 'nativeChatFileReference',
          attrs: { token: '@/folder/file.ts', path: '/folder/file.ts' }
        })
      }
    }
  )

  it.each([
    { content: [null] },
    { content: [{ type: 'paragraph', content: [null] }] },
    { content: {} },
    { content: [{ type: 'paragraph', content: 'broken' }] },
    { content: [{ type: 1 }] },
    { content: [{ type: 'text', text: 1 }] },
    { content: [{ type: 'text', text: 'kept', marks: [null] }] },
    { content: [{ type: 'text', text: 'kept', marks: {} }] },
    { content: [{ type: 'text', text: 'kept', marks: [{ type: 1 }] }] },
    { content: [{ type: 'text', text: 'kept', marks: [{ type: 'link', attrs: [] }] }] },
    { content: [{ type: 'nativeChatSkill', attrs: [] }] },
    { content: [{ type: 'nativeChatSkill', attrs: { token: { toString: null } } }] }
  ])('falls back to literal text and attachments for malformed nested content %j', (document) => {
    const parsed = parseStoredNativeChatComposerDraft({
      text: TEXT,
      textFormat: 'literal',
      document: { type: 'doc', ...document },
      images: IMAGES,
      owner: OWNER,
      savedAt: 1
    })
    expect(parsed).toEqual({
      text: TEXT,
      textFormat: 'literal',
      images: IMAGES,
      owner: OWNER,
      savedAt: 1
    })
  })

  it.each([undefined, 'literal'] as const)(
    'falls back before deeply nested content exhausts the cleanup stack with format %s',
    (textFormat) => {
      let document: { type: string; content: unknown[] } = { type: 'doc', content: [] }
      for (let depth = 0; depth < 5_000; depth += 1) {
        document = { type: 'doc', content: [document] }
      }
      expect(
        parseStoredNativeChatComposerDraft({
          text: 'kept',
          textFormat,
          document,
          images: [],
          savedAt: 1
        })
      ).toEqual({ text: 'kept', textFormat: 'literal', images: [], savedAt: 1 })
    }
  )

  it('still removes legacy image tokens from unmarked text when the document is malformed', () => {
    expect(
      parseStoredNativeChatComposerDraft({
        text: '[Image](orca-image:old) keep this',
        document: { type: 'doc', content: [null] },
        images: IMAGES,
        savedAt: 1
      })
    ).toEqual({ text: 'keep this', textFormat: 'literal', images: IMAGES, savedAt: 1 })
  })

  it('keeps newer node, mark and attribute fields through legacy image cleanup', () => {
    const paragraph = {
      type: 'paragraph',
      content: [
        { type: 'nativeChatImageReference', attrs: { token: '[Image](orca-image:old)' } },
        {
          type: 'text',
          text: ' kept',
          marks: [{ type: 'futureMark', attrs: { future: { value: true } }, future: true }]
        },
        { type: 'futureNode', attrs: { token: 'new', future: [1, 2] }, future: true }
      ]
    }
    const parsed = parseStoredNativeChatComposerDraft({
      text: 'old',
      document: { type: 'doc', content: [paragraph], future: true },
      images: IMAGES,
      savedAt: 1
    })
    expect(parsed?.text).toBe('keptnew')
    expect(parsed?.document).toEqual({
      type: 'doc',
      future: true,
      content: [
        { ...paragraph, content: [{ ...paragraph.content[1], text: 'kept' }, paragraph.content[2]] }
      ]
    })
    expect(parsed?.images).toEqual(IMAGES)
  })
})
