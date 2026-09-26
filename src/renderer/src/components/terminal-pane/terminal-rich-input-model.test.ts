import { describe, expect, it } from 'vitest'
import {
  TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
  TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER,
  terminalRichInputApplyResourceContext,
  terminalRichInputContentToClipboardText,
  terminalRichInputContentToText,
  terminalRichInputImageAttachments,
  terminalRichInputImageAttachmentsToContent,
  terminalRichInputPathsToContent,
  terminalRichInputRemoveSubmittedContent,
  terminalRichInputTextToContent
} from './terminal-rich-input-model'

describe('terminal rich input model', () => {
  it('parses file references into atomic editor nodes', () => {
    expect(terminalRichInputTextToContent('Review @src/app.ts and @"design notes.md"')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Review ' },
            { type: 'terminalFileMention', attrs: { path: 'src/app.ts' } },
            { type: 'text', text: ' and ' },
            { type: 'terminalFileMention', attrs: { path: 'design notes.md' } }
          ]
        }
      ]
    })
  })

  it('round trips multiline text and quoted file references', () => {
    const text = 'Review @src/app.ts\nThen open @"design notes.md"'
    expect(terminalRichInputContentToText(terminalRichInputTextToContent(text))).toBe(text)
  })

  it('copies mixed text, files, and images without the editor-only caret anchor', () => {
    expect(
      terminalRichInputContentToClipboardText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Review ' },
              {
                type: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
                attrs: { path: '/tmp/config.json' }
              },
              { type: 'text', text: ' with ' },
              {
                type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
                attrs: { path: '/tmp/design image.png' }
              },
              {
                type: 'text',
                text: `${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER} please`
              }
            ]
          }
        ]
      })
    ).toBe('Review @/tmp/config.json with @"/tmp/design image.png" please')
  })

  it('leaves email addresses as ordinary text', () => {
    const content = terminalRichInputTextToContent('Ask dev@example.com about @src/app.ts')
    expect(content.content?.[0].content?.[0]).toEqual({
      type: 'text',
      text: 'Ask dev@example.com about '
    })
    expect(terminalRichInputContentToText(content)).toBe('Ask dev@example.com about @src/app.ts')
  })

  it('keeps typed at-sign tokens as plain shell text when references are disabled', () => {
    expect(terminalRichInputTextToContent('echo @release', false)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'echo @release' }] }]
    })
  })

  it('inserts plain quoted paths instead of agent mentions for ordinary shells', () => {
    expect(
      terminalRichInputPathsToContent(['/repo/file.ts', '/repo/design notes.md'], false)
    ).toEqual([
      { type: 'text', text: '/repo/file.ts ' },
      { type: 'text', text: "'/repo/design notes.md' " }
    ])
  })

  it('shell-escapes plain terminal paths for the target platform', () => {
    expect(terminalRichInputPathsToContent(['/tmp/$(touch pwned)'], false)).toEqual([
      { type: 'text', text: "'/tmp/$(touch pwned)' " }
    ])
    expect(
      terminalRichInputPathsToContent(['C:\\Users\\orca\\a&b.txt'], false, undefined, 'windows')
    ).toEqual([{ type: 'text', text: '"C:\\Users\\orca\\a&b.txt" ' }])
  })

  it('serializes multiple editor paragraphs as terminal prompt lines', () => {
    expect(
      terminalRichInputContentToText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }
        ]
      })
    ).toBe('first\nsecond')
  })

  it('enriches legacy resource nodes without replacing their saved ownership', () => {
    const content = terminalRichInputApplyResourceContext(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
                attrs: { path: 'README.md', worktreeId: 'saved-worktree' }
              }
            ]
          }
        ]
      },
      {
        connectionId: 'connection-1',
        runtimeEnvironmentId: 'runtime-1',
        worktreeId: 'current-worktree',
        worktreePath: '/repo'
      }
    )

    expect(content.content?.[0]?.content?.[0]?.attrs).toEqual({
      connectionId: 'connection-1',
      runtimeEnvironmentId: 'runtime-1',
      worktreeId: 'saved-worktree',
      worktreePath: '/repo',
      path: 'README.md'
    })
  })

  it('preserves explicit local ownership when the current pane uses a remote route', () => {
    const content = terminalRichInputApplyResourceContext(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
                attrs: {
                  path: 'README.md',
                  connectionId: null,
                  runtimeEnvironmentId: null,
                  worktreeId: 'saved-worktree',
                  worktreePath: '/saved/repo'
                }
              }
            ]
          }
        ]
      },
      {
        connectionId: 'current-connection',
        runtimeEnvironmentId: 'current-runtime',
        worktreeId: 'current-worktree',
        worktreePath: '/current/repo'
      }
    )

    expect(content.content?.[0]?.content?.[0]?.attrs).toEqual({
      path: 'README.md',
      connectionId: null,
      runtimeEnvironmentId: null,
      worktreeId: 'saved-worktree',
      worktreePath: '/saved/repo'
    })
  })

  it('keeps image attachments inline without serializing them into prompt text', () => {
    const imageNodes = terminalRichInputImageAttachmentsToContent(
      [{ id: 'image-1', path: '/tmp/image.png' }],
      {
        connectionId: 'connection-1',
        runtimeEnvironmentId: 'runtime-1',
        worktreeId: 'worktree-1',
        worktreePath: '/repo'
      }
    )
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Fix this → ' }, ...imageNodes]
        }
      ]
    }

    expect(imageNodes).toEqual([
      {
        type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
        attrs: {
          id: 'image-1',
          path: '/tmp/image.png',
          connectionId: 'connection-1',
          runtimeEnvironmentId: 'runtime-1',
          worktreeId: 'worktree-1',
          worktreePath: '/repo'
        }
      },
      { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
    ])
    expect(terminalRichInputContentToText(content)).toBe('Fix this → ')
    expect(terminalRichInputContentToText(content, (path) => `@${path} `)).toBe(
      'Fix this → @/tmp/image.png '
    )
    expect(terminalRichInputImageAttachments(content)).toEqual([
      { id: 'image-1', path: '/tmp/image.png' }
    ])
  })

  it('removes a partially submitted image with its caret anchor', () => {
    const remaining = terminalRichInputRemoveSubmittedContent(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Fix ' },
              {
                type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
                attrs: { id: 'submitted', path: '/tmp/submitted.png' }
              },
              { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER },
              {
                type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
                attrs: { id: 'pending', path: '/tmp/pending.png' }
              },
              {
                type: 'text',
                text: `${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER} after`
              }
            ]
          }
        ]
      },
      ['submitted'],
      false
    )

    expect(remaining.content?.[0].content).toEqual([
      { type: 'text', text: 'Fix ' },
      {
        type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
        attrs: { id: 'pending', path: '/tmp/pending.png' }
      },
      { type: 'text', text: `${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER} after` }
    ])
  })

  it('clears submitted text and images while preserving attachments added during send', () => {
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Fix this ' },
            {
              type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
              attrs: { id: 'submitted', path: '/tmp/submitted.png' }
            },
            {
              type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
              attrs: { id: 'new', path: '/tmp/new.png' }
            }
          ]
        }
      ]
    }

    const remaining = terminalRichInputRemoveSubmittedContent(content, ['submitted'], true)

    expect(terminalRichInputContentToText(remaining)).toBe('')
    expect(remaining.content?.[0]?.content?.at(-1)).toEqual({
      type: 'text',
      text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER
    })
    expect(terminalRichInputImageAttachments(remaining).map(({ id }) => id)).toEqual(['new'])
  })
})
