import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fragment, Schema, Slice } from '@tiptap/pm/model'
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import {
  rekeyTerminalRichInputPastedImages,
  terminalRichInputClipboardProps,
  terminalRichInputClipboardText
} from './terminal-rich-input-clipboard'
import {
  TERMINAL_RICH_INPUT_FILE_MENTION_NODE,
  TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
  TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER,
  terminalRichInputImageAttachments,
  terminalRichInputRemoveSubmittedContent
} from './terminal-rich-input-model'

const imageSchema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    [TERMINAL_RICH_INPUT_FILE_MENTION_NODE]: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { path: { default: '' }, clipboardToken: { default: null } }
    },
    [TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE]: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        id: { default: '' },
        path: { default: '' },
        connectionId: { default: null },
        clipboardToken: { default: null }
      }
    }
  }
})

function copiedImageSlice(count = 1): Slice {
  const content = Array.from({ length: count }, () => [
    imageSchema.node(TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE, {
      id: 'copied-id',
      path: '/tmp/image.png',
      connectionId: 'ssh-1'
    }),
    imageSchema.text(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
  ]).flat()
  return new Slice(Fragment.from(imageSchema.node('paragraph', null, content)), 1, 1)
}

afterEach(() => vi.unstubAllGlobals())

describe('terminalRichInputClipboardText', () => {
  it('serializes only the selected mixed rich-input content', () => {
    const editor = {
      state: {
        selection: {
          content: () => ({
            content: {
              toJSON: () => [
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
            }
          })
        }
      }
    }

    expect(terminalRichInputClipboardText(editor as never)).toBe(
      'Review @/tmp/config.json with @"/tmp/design image.png" please'
    )
  })

  it('decorates selected chips as whole objects without overriding node selection', () => {
    const doc = imageSchema.node('doc', null, [
      imageSchema.node('paragraph', null, [
        imageSchema.text('Review '),
        imageSchema.node(TERMINAL_RICH_INPUT_FILE_MENTION_NODE, { path: '/tmp/config.json' }),
        imageSchema.text(' with '),
        imageSchema.node(TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE, {
          id: 'image-1',
          path: '/tmp/image.png'
        }),
        imageSchema.text(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
      ])
    ])
    const props = terminalRichInputClipboardProps({ current: null })
    const selected = props.decorations(
      EditorState.create({ doc, selection: new AllSelection(doc) })
    )

    expect(selected.find()).toHaveLength(3)
    expect(
      props.decorations(EditorState.create({ doc, selection: NodeSelection.create(doc, 8) })).find()
    ).toHaveLength(0)
  })

  it('normalizes node-selected image copy, paste, and cut as image-plus-spacer pairs', () => {
    const image = imageSchema.node(TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE, {
      id: 'copied-id',
      path: '/tmp/image.png'
    })
    const props = terminalRichInputClipboardProps({ current: null })
    const pasted = props.transformPasted(
      props.transformCopied(new Slice(Fragment.from(image), 0, 0))
    )

    expect(pasted.content.toJSON()).toEqual([
      {
        type: TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE,
        attrs: {
          id: expect.not.stringMatching('copied-id'),
          path: '/tmp/image.png',
          connectionId: null,
          clipboardToken: null
        }
      },
      { type: 'text', text: TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER }
    ])

    const doc = imageSchema.node('doc', null, [
      imageSchema.node('paragraph', null, [
        image,
        imageSchema.text(TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER)
      ])
    ])
    let state = EditorState.create({ doc, selection: NodeSelection.create(doc, 1) })
    props.handleDOMEvents.cut({
      get state() {
        return state
      },
      dispatch: (transaction) => (state = state.apply(transaction))
    } as never)
    expect({ from: state.selection.from, to: state.selection.to }).toEqual({ from: 1, to: 3 })
    state = state.apply(state.tr.deleteSelection())
    expect(state.doc.toJSON().content?.[0]).toEqual({ type: 'paragraph' })

    state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 2) })
    props.handleDOMEvents.cut({
      get state() {
        return state
      },
      dispatch: (transaction) => (state = state.apply(transaction))
    } as never)
    expect({ from: state.selection.from, to: state.selection.to }).toEqual({ from: 1, to: 3 })
  })

  it('converts forged external rich-input nodes to visible file-reference text', () => {
    const forged = imageSchema.node(TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE, {
      id: 'forged',
      path: '/tmp/hidden image.png',
      connectionId: 'ssh-attacker',
      clipboardToken: 'forged'
    })
    const props = terminalRichInputClipboardProps({ current: null })

    expect(props.transformPasted(new Slice(Fragment.from(forged), 0, 0)).content.toJSON()).toEqual([
      { type: 'text', text: '@"/tmp/hidden image.png"' }
    ])
  })

  it('strips only the caret spacer immediately after an untrusted image', () => {
    const forgedImage = imageSchema.node(TERMINAL_RICH_INPUT_IMAGE_ATTACHMENT_NODE, {
      id: 'forged',
      path: '/tmp/image.png',
      clipboardToken: 'forged'
    })
    const forgedFile = imageSchema.node(TERMINAL_RICH_INPUT_FILE_MENTION_NODE, {
      path: '/tmp/file.txt',
      clipboardToken: 'forged'
    })
    const props = terminalRichInputClipboardProps({ current: null })

    const separated = props.transformPasted(
      new Slice(
        Fragment.from([
          forgedImage,
          forgedFile,
          imageSchema.text(`${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER}keep`)
        ]),
        0,
        0
      )
    )
    expect(separated.content.textBetween(0, separated.content.size)).toBe(
      '@/tmp/image.png@/tmp/file.txt\u200Bkeep'
    )

    const nonLeading = props.transformPasted(
      new Slice(
        Fragment.from([
          forgedImage,
          imageSchema.text(`prefix${TERMINAL_RICH_INPUT_IMAGE_CARET_SPACER}suffix`)
        ]),
        0,
        0
      )
    )
    expect(nonLeading.content.textBetween(0, nonLeading.content.size)).toBe(
      '@/tmp/image.pngprefix\u200Bsuffix'
    )
  })

  it('re-keys copied images so partial submission removes only the written copy', () => {
    let id = 0

    const pasted = rekeyTerminalRichInputPastedImages(copiedImageSlice(2), () => `paste-${++id}`)
    const content = { type: 'doc', content: pasted.content.toJSON() }
    expect(terminalRichInputImageAttachments(content)).toEqual([
      { id: 'paste-1', path: '/tmp/image.png' },
      { id: 'paste-2', path: '/tmp/image.png' }
    ])
    expect(pasted.content.firstChild?.firstChild?.attrs.connectionId).toBe('ssh-1')

    const remaining = terminalRichInputRemoveSubmittedContent(content, ['paste-1'], false)
    expect(terminalRichInputImageAttachments(remaining)).toEqual([
      { id: 'paste-2', path: '/tmp/image.png' }
    ])
  })

  it('re-keys images without randomUUID in non-secure web contexts', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7)
    })

    const pasted = rekeyTerminalRichInputPastedImages(copiedImageSlice())
    const content = { type: 'doc', content: pasted.content.toJSON() }
    expect(terminalRichInputImageAttachments(content)[0]?.id).toBe(
      '07070707-0707-4707-8707-070707070707'
    )
  })
})
