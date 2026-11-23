// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store/index', async (importOriginal) => importOriginal())

import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
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
  return { view, input: inputRef.current! }
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
