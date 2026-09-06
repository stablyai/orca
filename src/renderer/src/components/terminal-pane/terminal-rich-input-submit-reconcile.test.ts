import { describe, expect, it, vi } from 'vitest'
import { TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER } from './terminal-rich-input-model'
import { removeWrittenTerminalRichInputContent } from './terminal-rich-input-submit-reconcile'

describe('removeWrittenTerminalRichInputContent', () => {
  it('removes written text and images while preserving unsent inline attachments', () => {
    const setContent = vi.fn()
    const editor = {
      getJSON: () => ({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Fix this ' },
              { type: 'terminalImageAttachment', attrs: { id: 'first' } },
              { type: 'terminalImageAttachment', attrs: { id: 'second' } }
            ]
          }
        ]
      }),
      commands: { setContent }
    } as never

    removeWrittenTerminalRichInputContent(
      { status: 'partially-written', imagePathsWritten: 1, textWritten: true },
      [
        { id: 'first', path: '/tmp/first.png' },
        { id: 'second', path: '/tmp/second.png' }
      ],
      editor
    )
    expect(setContent).toHaveBeenCalledWith(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'terminalImageAttachment', attrs: { id: 'second' } },
              { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
            ]
          }
        ]
      },
      { emitUpdate: true }
    )
  })
})
