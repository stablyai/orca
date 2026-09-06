import { describe, expect, it, vi } from 'vitest'
import { submitTerminalRichInputEditor } from './terminal-rich-input-editor-submit'
import { TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER } from './terminal-rich-input-model'

describe('submitTerminalRichInputEditor', () => {
  it('serializes inline image references in editor order', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ status: 'submitted' })
    const editor = {
      setEditable: vi.fn(),
      getJSON: () => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'open ' },
              {
                type: 'terminalImageAttachment',
                attrs: { id: 'image-1', path: '/tmp/design image.png' }
              },
              { type: 'text', text: ' now' }
            ]
          }
        ]
      }),
      commands: { setContent: vi.fn(), focus: vi.fn() }
    } as never

    await submitTerminalRichInputEditor({
      draft: 'open  now',
      attachments: [{ id: 'image-1', path: '/tmp/design image.png' }],
      editor,
      onSubmit,
      inlineImageText: (imagePath) => `"${imagePath}" `
    })

    expect(onSubmit).toHaveBeenCalledWith('open "/tmp/design image.png"  now', [])
  })

  it('clears inline images when their combined text reached the PTY', async () => {
    const setContent = vi.fn()
    const editor = {
      setEditable: vi.fn(),
      getJSON: () => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'open ' },
              {
                type: 'terminalImageAttachment',
                attrs: { id: 'image-1', path: '/tmp/image.png' }
              }
            ]
          }
        ]
      }),
      commands: { setContent, focus: vi.fn() }
    } as never

    const result = await submitTerminalRichInputEditor({
      draft: 'open ',
      attachments: [{ id: 'image-1', path: '/tmp/image.png' }],
      editor,
      onSubmit: vi.fn().mockResolvedValue({
        status: 'partially-written',
        imagePathsWritten: 0,
        textWritten: true
      }),
      inlineImageText: (imagePath) => `${imagePath} `
    })

    expect(result).toEqual({
      status: 'partially-written',
      imagePathsWritten: 1,
      textWritten: true
    })
    expect(setContent).toHaveBeenCalledWith(
      { type: 'doc', content: [{ type: 'paragraph', content: [] }] },
      { emitUpdate: true }
    )
  })

  it('clears submitted content while preserving attachments added during send', async () => {
    const setEditable = vi.fn()
    const setContent = vi.fn()
    const focus = vi.fn()
    const editor = {
      setEditable,
      getJSON: () => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Fix this' },
              { type: 'terminalImageAttachment', attrs: { id: 'submitted' } },
              { type: 'terminalImageAttachment', attrs: { id: 'new' } }
            ]
          }
        ]
      }),
      commands: { setContent, focus }
    } as never

    const onSubmit = vi.fn().mockResolvedValue({ status: 'submitted' })
    const result = await submitTerminalRichInputEditor({
      draft: 'Fix this',
      attachments: [{ id: 'submitted', path: '/tmp/submitted.png' }],
      editor,
      onSubmit
    })

    expect(result).toEqual({ status: 'submitted' })
    expect(onSubmit).toHaveBeenCalledWith('Fix this', ['/tmp/submitted.png'])
    expect(setEditable.mock.calls).toEqual([[false], [true]])
    expect(setContent).toHaveBeenCalledWith(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'terminalImageAttachment', attrs: { id: 'new' } },
              { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
            ]
          }
        ]
      },
      { emitUpdate: true }
    )
    expect(focus).toHaveBeenCalledWith('end')
  })
})
