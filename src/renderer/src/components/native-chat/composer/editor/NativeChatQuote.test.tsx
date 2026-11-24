// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import {
  writeNativeChatComposerText,
  type NativeChatComposerInput
} from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import {
  FILE_REFERENCE_NODE,
  IMAGE_REFERENCE_NODE,
  openingPromptContent,
  promptTextContent
} from './native-chat-prompt-document-text'
import { useNativeChatTypedInsertion } from './use-native-chat-typed-insertion'
import { formatNativeChatQuote } from '../../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

afterEach(cleanup)

function setup(value = '') {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={value}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  const input = inputRef.current!
  return { ...view, input, editor: promptEditor(screen.getByRole('textbox')) }
}

const chips = (editor: ReturnType<typeof promptEditor>) => {
  let count = 0
  editor.state.doc.descendants((node) => {
    count += node.type.name === 'nativeChatQuote' ? 1 : 0
  })
  return count
}

describe('quote chips in the composer', () => {
  it('reads quoted lines, a blank line and the next line as one chip line', () => {
    const doc = promptTextContent('above\n> one\n>\n> two\n\nbelow')
    expect(doc.content?.map((block) => block.content?.map((node) => node.type))).toEqual([
      ['text'],
      ['nativeChatQuote', 'text']
    ])
    expect(doc.content?.[1]?.content?.[0]?.attrs?.token).toBe('> one\n>\n> two\n\n')
    // Quoted lines with text directly below are a lazy blockquote, not a chip; pastes stay literal.
    expect(promptTextContent('> one\nbelow').content?.[0]?.content?.[0]?.type).toBe('text')
    expect(promptTextContent('> one\n\n', { literal: true }).content?.[0]?.content?.[0]?.type).toBe(
      'text'
    )
  })

  // Quoted lines at the end of the text, with no blank line after them, are text: a chip adds one.
  it('keeps quoted lines and one line end at the end of the text as text', () => {
    const { input, editor } = setup('> a\n')
    expect(input.value).toBe('> a\n')
    expect(chips(editor)).toBe(0)
  })

  // A line with an image or file pill is not a quote line and not a blank line.
  it.each([
    [
      'a file pill line under a quote line',
      [
        [{ type: 'text', text: '> q' }],
        [{ type: FILE_REFERENCE_NODE, attrs: { token: '@a.ts', path: '' } }],
        [{ type: 'text', text: 'c' }]
      ]
    ],
    [
      'an image pill line, a blank line and a line',
      [
        [{ type: IMAGE_REFERENCE_NODE, attrs: { attachmentId: 'i' } }],
        [],
        [{ type: 'text', text: 'c' }]
      ]
    ]
  ])('keeps %s with no quote chip', (_name, lines) => {
    const document = {
      type: 'doc',
      content: lines.map((content) => ({ type: 'paragraph', content }))
    }
    expect(openingPromptContent(document, '')).toEqual(document)
  })

  it('shows an added quote as a chip and sends the same Markdown quote', () => {
    const { input, editor } = setup('hi')
    const next = `hi\n\n${formatNativeChatQuote('quoted\nwords')}`
    act(() => {
      input.value = next
      input.setSelectionRange(next.length, next.length)
    })
    expect(input.value).toBe(next)
    expect(chips(editor)).toBe(1)
  })

  it('keeps text typed after the chip on its line, and text typed before it on the line above', () => {
    const { input, editor } = setup('> q\n\n')
    expect(chips(editor)).toBe(1)
    // Add to chat leaves the caret right after the chip.
    act(() => {
      input.setSelectionRange(input.value.length, input.value.length)
      editor.commands.insertContent('hello')
    })
    expect(input.value).toBe('> q\n\nhello')
    expect(editor.state.doc.childCount).toBe(1)
    act(() => {
      editor.commands.setTextSelection(1)
      editor.commands.insertContent('above')
    })
    expect(input.value).toBe('above\n> q\n\nhello')
    // The caret stays after the typed text.
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5])
  })

  type Editor = ReturnType<typeof promptEditor>
  const typeAt =
    (at: number, text: string) =>
    ({ editor }: { editor: Editor }): void => {
      editor.commands.setTextSelection(at)
      editor.commands.insertContent(text)
    }
  /**
   * Typed lines, an empty line and a chip line; then the chip line joins the empty line, as a delete
   * across the empty line does.
   */
  const joinChipLineUnder =
    (lines: string[]) =>
    ({ editor }: { editor: Editor }): void => {
      editor.commands.setContent({
        type: 'doc',
        content: [
          ...lines.map((text) =>
            text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }
          ),
          { type: 'paragraph' },
          {
            type: 'paragraph',
            content: [
              { type: 'nativeChatQuote', attrs: { token: '> q\n\n' } },
              { type: 'text', text: 'c' }
            ]
          }
        ]
      })
      const chipLine = lines.reduce((size, text) => size + text.length + 2, 2)
      editor.commands.setTextSelection(chipLine + 1)
      editor.commands.joinBackward()
    }
  const QUOTE_LINE_CASES: [
    name: string,
    text: string,
    act: (setup: { editor: Editor; input: NativeChatComposerInput }) => void,
    sent: string,
    tokens: string[]
  ][] = [
    [
      '> x typed between two chips',
      '> a\n\n> b\n\n',
      typeAt(2, '> x'),
      '> a\n\n> x\n\n> b\n\n',
      ['> a\n\n', '> b\n\n']
    ],
    ['> x typed before a chip', '> q\n\n', typeAt(1, '> x'), '> x\n\n> q\n\n', ['> q\n\n']],
    ['>x typed before a chip', '> q\n\n', typeAt(1, '>x'), '>x\n\n> q\n\n', ['> q\n\n']],
    [
      'an indented > x typed before a chip',
      '> q\n\n',
      typeAt(1, '   > x'),
      '   > x\n\n> q\n\n',
      ['> q\n\n']
    ],
    [
      'a join of a chip line to the empty line under a typed quote line',
      '',
      joinChipLineUnder(['> typed']),
      '> typed\n\n> q\n\nc',
      ['> q\n\n']
    ],
    [
      'a join of a chip line under a quote line and a lazy line',
      '',
      joinChipLineUnder(['> x', 'foo']),
      '> x\nfoo\n\n> q\n\nc',
      ['> q\n\n']
    ],
    [
      'a join of a chip line under a text line, a blank line and a quote line',
      '',
      joinChipLineUnder(['> x', '', 'foo']),
      '> x\n\nfoo\n> q\n\nc',
      ['> q\n\n']
    ],
    [
      'a join of a chip line under two text lines',
      '',
      joinChipLineUnder(['foo', 'bar']),
      'foo\nbar\n> q\n\nc',
      ['> q\n\n']
    ],
    [
      'a paste of >x before a chip',
      '> q\n\n',
      ({ editor }) => {
        editor.commands.setTextSelection(1)
        fireEvent.paste(screen.getByRole('textbox'), {
          clipboardData: { getData: (format: string) => (format === 'text/plain' ? '>x' : '') }
        })
      },
      '>x\n\n> q\n\n',
      ['> q\n\n']
    ],
    [
      'an API write of >x directly above a chip',
      '> q\n\n',
      ({ input }) => writeNativeChatComposerText(input, '>x\n> q\n\n', 0),
      '>x\n> q\n\n',
      ['>x\n> q\n\n']
    ],
    ['a text line typed before a chip', '> q\n\n', typeAt(1, 'x'), 'x\n> q\n\n', ['> q\n\n']]
  ]

  // The agent reads Markdown: a quote line directly above a chip joins the chip's blockquote.
  it.each(QUOTE_LINE_CASES)(
    'shows and sends the blockquotes the agent reads after %s',
    (_name, text, change, sent, tokens) => {
      const { input, editor } = setup(text)
      act(() => change({ editor, input }))
      expect(input.value).toBe(sent)
      const shown: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'nativeChatQuote') {
          shown.push(String(node.attrs.token))
        }
      })
      expect(shown).toEqual(tokens)
    }
  )

  // Add to chat: the quote goes where the caret is, on a line of its own; empty lines stay.
  it.each([
    ['on an empty line', 'top\n\n\nend', 5, 5, 'top\n\n> q\n\n\nend'],
    ['at the end, after empty lines', 'top\n\n\n', 6, 6, 'top\n\n\n> q\n\n'],
    ['inside a line: the rest is the comment', 'foobar', 3, 3, 'foo\n> q\n\nbar'],
    ['at the end of a selection, which stays', 'foobar', 1, 3, 'foo\n> q\n\nbar']
  ])('adds a quote at the caret %s', (_name, text, from, to, added) => {
    const { input, editor } = setup(text)
    act(() => input.setSelectionRange(from, to))
    const { result } = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: { current: input },
        isComposing: () => false,
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      })
    )
    act(() => result.current.insertQuote('> q\n\n'))
    expect(input.value).toBe(added)
    expect(chips(editor)).toBe(1)
    // The caret is right after the chip, where the comment goes.
    const after = added.indexOf('> q\n\n') + '> q\n\n'.length
    expect([input.selectionStart, input.selectionEnd]).toEqual([after, after])
  })

  // A restored draft shows its caret at the start until the user puts one in the box.
  it('adds a quote after the draft in a box where the user put no caret', () => {
    const { input, editor } = setup('top\nend')
    const { result } = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: { current: input },
        isComposing: () => false,
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      })
    )
    act(() => result.current.insertQuote('> q\n\n'))
    expect(input.value).toBe('top\nend\n> q\n\n')
    expect(chips(editor)).toBe(1)
  })

  // A paste keeps its text: quoted lines that the user pastes stay lines of text.
  it('keeps pasted quote lines as text, with no chip', () => {
    const { input, editor } = setup('')
    act(() => {
      editor.commands.setTextSelection(1)
      fireEvent.paste(screen.getByRole('textbox'), {
        clipboardData: {
          getData: (format: string) => (format === 'text/plain' ? '> x\n\nc' : '')
        }
      })
    })
    expect(input.value).toBe('> x\n\nc')
    expect(chips(editor)).toBe(0)
  })

  // Other text, such as a saved automation's note, goes after the draft.
  it('appends text after the draft and a blank line, wherever the caret is', () => {
    const { input } = setup('top\nend')
    act(() => input.setSelectionRange(1, 1))
    const { result } = renderHook(() =>
      useNativeChatTypedInsertion({
        textareaRef: { current: input },
        isComposing: () => false,
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      })
    )
    act(() => result.current.appendText('note'))
    expect(input.value).toBe('top\nend\n\nnote')
  })

  it('shows text written after a chip through the composer API on the chip line', () => {
    const { input, editor } = setup('> q\n\n')
    act(() => writeNativeChatComposerText(input, '> q\n\nhello', '> q\n\nhello'.length))
    expect(input.value).toBe('> q\n\nhello')
    const first = editor.state.doc.child(0)
    expect(first.childCount).toBe(2)
    expect(first.child(0).attrs.token).toBe('> q\n\n')
    expect(first.child(1).text).toBe('hello')
  })
})
