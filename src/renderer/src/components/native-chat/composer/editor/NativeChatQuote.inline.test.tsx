// @vitest-environment happy-dom
import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store/index', async (importOriginal) => importOriginal())

import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import { TooltipProvider } from '@/components/ui/tooltip'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'

afterEach(() => {
  cleanup()
  clearNativeChatComposerDraftsForTests()
})

const CHIP = 'CHIP'

const isQuoteChip = (node: Element): boolean =>
  node.querySelector('[data-native-chat-sent-quote]') !== null ||
  [...node.querySelectorAll('.sr-only')].some((label) => label.textContent?.startsWith('Quote'))

/** What a node shows, without the spoken labels of other pills. */
function shownText(node: Node): string {
  const copy = node.cloneNode(true)
  if (!(copy instanceof Element)) {
    return node.textContent ?? ''
  }
  copy.querySelectorAll('.sr-only').forEach((label) => label.remove())
  return copy.textContent ?? ''
}

/** A line as a reader sees it: CHIP for each quote chip, then the text, one space apart. */
function lineText(line: Element): string {
  return [...line.childNodes]
    .map((node) => (node instanceof Element && isQuoteChip(node) ? CHIP : shownText(node).trim()))
    .filter((part) => part !== '')
    .join(' ')
}

function mount(text: string) {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatPromptEditor
      inputRef={inputRef}
      initialValue={text}
      disabled={false}
      placeholder="Message"
      onChange={vi.fn()}
      onSelect={vi.fn()}
    />
  )
  return { view, input: inputRef.current!, editor: promptEditor(screen.getByRole('textbox')) }
}

/** The composer lines, after the text the agent gets is checked to be `text`. HIDDEN: a hidden line. */
async function composerLines(text: string): Promise<string[]> {
  const { view, input } = mount(text)
  await waitFor(() => expect(view.container.textContent).toContain('Quote: '))
  expect(input.value).toBe(text)
  return [...view.container.querySelectorAll('.ProseMirror > p')].map((line) =>
    line.matches('[aria-hidden="true"], .h-0') ? 'HIDDEN' : lineText(line)
  )
}

function renderSent(text: string): Element {
  const view = render(
    <TooltipProvider>
      <NativeChatMarkdown content={text} variant="document" quoteChips />
    </TooltipProvider>
  )
  return view.container.querySelector('.native-chat-markdown')!
}

/** The sent message, as lines: a block of the Markdown, or '' for a visible empty line. */
function sentLines(text: string): string[] {
  return [...renderSent(text).children].map((block) =>
    block.matches('[data-native-chat-sent-quote]') ? CHIP : lineText(block)
  )
}

// The sent text keeps the quote, a blank line, then the comment; the comment shows on the chip's line.
const TABLE: [string, string, string[]][] = [
  ['a comment after a quote', '> q\n\nc', [`${CHIP} c`]],
  ['a comment after each quote', '> a\n\nc1\n> b\n\nc2', [`${CHIP} c1`, `${CHIP} c2`]],
  // An empty line that the user typed above a quote shows.
  [
    'an empty line between two chip lines',
    '> a\n\nc1\n\n> b\n\nc2',
    [`${CHIP} c1`, '', `${CHIP} c2`]
  ],
  ['two quotes, then a comment', '> a\n\n> b\n\nc', [`${CHIP} ${CHIP} c`]],
  ['a line below a quote', '> q\n\n\nbelow', [CHIP, 'below']],
  ['an empty line below a quote', '> q\n\n\n\nbelow', [CHIP, '', 'below']],
  ['a line above a quote', 'above\n> q\n\nc', ['above', `${CHIP} c`]],
  ['an empty line above a quote', 'above\n\n> q\n\nc', ['above', '', `${CHIP} c`]],
  ['two empty lines above a quote', 'above\n\n\n> q\n\nc', ['above', '', '', `${CHIP} c`]]
]

it.each(TABLE)('shows %s in the composer', async (_name, text, lines) => {
  expect(await composerLines(text)).toEqual(lines)
})

it.each(TABLE)('shows %s the same way when sent', (_name, text, lines) => {
  expect(sentLines(text)).toEqual(lines)
})

it('marks each sent chip line, so it takes no paragraph gap above or below it', () => {
  const root = renderSent('above\n> a\n\nc1\n> b\n\nc2')
  expect(
    [...root.children].map((block) => block.hasAttribute('data-native-chat-quote-line'))
  ).toEqual([false, true, true])
})

it('puts one space between the chip and the comment, in the composer and when sent', async () => {
  const { view } = mount('> q\n\nc')
  await waitFor(() => expect(view.container.textContent).toContain('Quote: '))
  // No text has a space there: the chip's end margin is the space.
  expect(view.container.querySelector('.ProseMirror [data-selected]')!.classList).toContain('me-1')
  cleanup()
  const chip = renderSent('> q\n\nc').querySelector('[data-native-chat-sent-quote]')!
  expect(chip.classList).toContain('me-1')
  expect(chip.nextSibling?.textContent).toBe('c')
})

const NATIVE = 'native'

// ProseMirror reads keyCode for the keys it handles itself: caret moves and deletes next to a pill.
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowRight: 39
}
const press = (key: string): boolean =>
  fireEvent.keyDown(screen.getByRole('textbox'), { key, keyCode: KEY_CODES[key] })

/**
 * Backspace and Delete at each caret place of each document. A line is shown with its number,
 * [q] for a chip and | for the caret. An outcome is the text after the key, or NATIVE: the editor
 * leaves the key to the browser, which deletes one character of text.
 */
const KEY_TABLE: [text: string, cases: [caret: string, backspace: string, del: string][]][] = [
  [
    '> q\n\n',
    [
      ['0 |[q]', '> q\n\n', ''],
      ['0 [q]|', '', '> q\n\n']
    ]
  ],
  [
    '> q\n\nc',
    [
      ['0 |[q]c', '> q\n\nc', 'c'],
      ['0 [q]|c', 'c', NATIVE],
      ['0 [q]c|', NATIVE, '> q\n\nc']
    ]
  ],
  [
    'x\n> q\n\nc\ny',
    [
      ['0 |x', 'x\n> q\n\nc\ny', NATIVE],
      ['0 x|', NATIVE, 'x\n> q\n\nc\ny'],
      ['1 |[q]c', 'x\n> q\n\nc\ny', 'x\nc\ny'],
      ['1 [q]|c', 'x\nc\ny', NATIVE],
      ['1 [q]c|', NATIVE, 'x\n> q\n\ncy'],
      ['2 |y', 'x\n> q\n\ncy', NATIVE],
      ['2 y|', NATIVE, 'x\n> q\n\nc\ny']
    ]
  ],
  [
    '> a\n\n> b\n\n',
    [
      ['0 |[a][b]', '> a\n\n> b\n\n', '> b\n\n'],
      ['0 [a]|[b]', '> b\n\n', '> a\n\n'],
      ['0 [a][b]|', '> a\n\n', '> a\n\n> b\n\n']
    ]
  ],
  [
    '> a\n\n\n> b\n\nc',
    [
      ['0 |[a]', '> a\n\n\n> b\n\nc', '\n> b\n\nc'],
      ['0 [a]|', '\n> b\n\nc', '> a\n\n> b\n\nc'],
      ['1 |[b]c', '> a\n\n> b\n\nc', '> a\n\n\nc'],
      ['1 [b]|c', '> a\n\n\nc', NATIVE],
      ['1 [b]c|', NATIVE, '> a\n\n\n> b\n\nc']
    ]
  ]
]

/** Each caret place of the document, in order, with its label. */
function caretPlaces(editor: ReturnType<typeof promptEditor>): [string, number][] {
  const places: [string, number][] = []
  editor.state.doc.forEach((block, offset, line) => {
    const parts: string[] = []
    const positions: number[] = []
    block.forEach((node, childOffset) => {
      const label = node.isText ? node.text! : `[${String(node.attrs.token).slice(2, 3)}]`
      for (let index = 0; index < (node.isText ? node.nodeSize : 1); index++) {
        positions.push(offset + 1 + childOffset + index)
      }
      parts.push(...(node.isText ? [...label] : [label]))
    })
    positions.push(offset + 1 + block.content.size)
    positions.forEach((position, at) => {
      const text = [...parts.slice(0, at), '|', ...parts.slice(at)].join('')
      places.push([`${line} ${text}`, position])
    })
  })
  return places
}

const KEY_CASES = KEY_TABLE.flatMap(([text, cases]) =>
  cases.flatMap(([caret, backspace, del], place) => [
    ['Backspace', text, caret, place, backspace] as const,
    ['Delete', text, caret, place, del] as const
  ])
)

it.each(KEY_CASES)('%s on %j at %s', (key, text, _caret, place, outcome) => {
  const { input, editor } = mount(text)
  const places = caretPlaces(editor)
  expect(places.map(([label]) => label)).toEqual(
    KEY_TABLE.find(([table]) => table === text)![1].map(([label]) => label)
  )
  act(() => {
    editor.commands.setTextSelection(places[place][1])
  })
  let browserHandles = false
  act(() => {
    browserHandles = press(key)
  })
  if (outcome === NATIVE) {
    expect(browserHandles).toBe(true)
    expect(input.value).toBe(text)
    return
  }
  expect(browserHandles).toBe(false)
  expect(input.value).toBe(outcome)
})

// The browser moves the caret past the chip there, and ProseMirror moves it back.
it('keeps ArrowRight at the end, after a chip, from the browser: the caret stays', () => {
  const { editor } = mount('> q\n\n')
  act(() => {
    editor.commands.setTextSelection(2)
  })
  let browserHandles = true
  act(() => {
    browserHandles = press('ArrowRight')
  })
  expect(browserHandles).toBe(false)
  expect(editor.state.selection.from).toBe(2)
})

it('moves the caret across a chip as across an image: one press steps over it', () => {
  const { input, editor } = mount('> q\n\nc')
  const key = (name: string) =>
    act(() => {
      press(name)
    })
  act(() => editor.commands.setTextSelection(1))
  key('ArrowRight')
  expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 2, head: 2 })
  act(() => {
    editor.commands.insertContent('x')
  })
  expect(input.value).toBe('> q\n\nxc')
  act(() => editor.commands.setTextSelection(2))
  key('ArrowLeft')
  expect(editor.state.selection.toJSON()).toEqual({ type: 'text', anchor: 1, head: 1 })
})
