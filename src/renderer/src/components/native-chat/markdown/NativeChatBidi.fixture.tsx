import { useRef, useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatCodeBlock } from './code/NativeChatCodeBlock'
import { NativeChatPromptEditor } from '../composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from '../composer/editor/native-chat-composer-input'

const PARAGRAPHS = [
  'سلام دنیا؛ آماده‌ای؟',
  'مرحباً بالعالم؛ كيف حالك؟',
  'Hello, world! Ready?',
  'سلام **Orca**؛ نسخه 2 آماده است.',
  'Use **Orca** برای نوشتن متن فارسی.',
  '`npm test` را اجرا کنید.',
  '123 ... (سلام Orca).',
  '[src/متن.ts](#orca-native-chat-file-path=src%2F%D9%85%D8%AA%D9%86.ts) را باز کنید.'
]
const DIRECTIONS = ['rtl', 'rtl', 'ltr', 'rtl', 'ltr', 'rtl', 'rtl', 'rtl'] as const

function BidiChat(): React.JSX.Element {
  const input = useRef<NativeChatComposerInput>(null)
  const [tail, setTail] = useState('123 ...')
  return (
    <div className="native-chat-appearance space-y-4 p-4">
      {['user', 'assistant'].map((role) => (
        <div key={role} data-bidi-role={role}>
          <NativeChatMarkdown variant="document" content={PARAGRAPHS.join('\n\n')} />
        </div>
      ))}
      <div data-bidi-stream>
        <NativeChatMarkdown variant="document" content={tail} streaming />
      </div>
      <button onClick={() => setTail('123 ... سلام Orca؛ آماده است.')}>
        Append Persian response
      </button>
      <NativeChatMarkdown
        variant="document"
        renderCodeBlock={NativeChatCodeBlock}
        content={
          '```sh\nnpm test -- --name="سلام"\n```\n\n> سلام دنیا\n\n- سلام دنیا\n- Hello world\n- `npm test` را اجرا کنید.\n- Run `npm test` now.\n\n# سلام دنیا\n\n| فارسی | English |\n| --- | --- |\n| سلام | Hello |'
        }
      />
      <NativeChatPromptEditor
        inputRef={input}
        initialValue={PARAGRAPHS.slice(0, 5)
          .map((p) => p.replaceAll('**', ''))
          .join('\n')}
        disabled={false}
        placeholder="Ask anything"
        onChange={() => {}}
        onSelect={() => {}}
      />
      <button
        onClick={() => {
          if (input.current) {
            input.current.value = 'سلام Orca؛ آماده است.'
          }
        }}
      >
        Replace draft
      </button>
    </div>
  )
}

function assertAligned(element: Element, direction: 'ltr' | 'rtl'): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const content = range.getBoundingClientRect()
  const block = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const gap =
    direction === 'rtl'
      ? block.right -
        content.right -
        Number.parseFloat(style.paddingRight) -
        Number.parseFloat(style.borderRightWidth)
      : content.left -
        block.left -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.borderLeftWidth)
  if (Math.abs(gap) > 2) {
    throw new Error(`Expected ${direction} alignment: ${element.textContent}`)
  }
}

function characterLeft(element: Element, offset: number): number {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const length = node.textContent!.length
    if (offset < length) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      return range.getBoundingClientRect().left
    }
    offset -= length
  }
  throw new Error('Missing character')
}

export const preview = defineFixture({ width: 640, render: () => <BidiChat /> })

// These checks need Chromium's Unicode layout engine; DOM simulators cannot catch BiDi regressions.
export const bidi = defineFixture({
  width: 640,
  render: () => <BidiChat />,
  interact: async (frame) => {
    for (const role of ['user', 'assistant']) {
      const paragraphs = frame.querySelectorAll(`[data-bidi-role="${role}"] p`)
      if (paragraphs.length !== DIRECTIONS.length) {
        throw new Error('Missing Markdown paragraphs')
      }
      paragraphs.forEach((p, index) => assertAligned(p, DIRECTIONS[index]))
      for (const index of [0, 1, 3]) {
        const p = paragraphs[index]
        if (characterLeft(p, p.textContent!.length - 1) >= characterLeft(p, 0)) {
          throw new Error('RTL sentence punctuation moved to the right')
        }
      }
      const mixed = paragraphs[3]
      const orca = mixed.textContent!.indexOf('Orca')
      if (characterLeft(mixed, orca) >= characterLeft(mixed, orca + 3)) {
        throw new Error('English run reversed inside Persian')
      }
      if (mixed.querySelector('strong')?.textContent !== 'Orca') {
        throw new Error('Markdown lost')
      }
    }
    const composer = frame.querySelector('[data-native-chat-prompt-editor]')!
    composer.querySelectorAll('p').forEach((p, index) => assertAligned(p, DIRECTIONS[index]))
    const items = frame.querySelectorAll('li')
    if (
      getComputedStyle(items[0]).direction !== 'rtl' ||
      getComputedStyle(items[1]).direction !== 'ltr' ||
      getComputedStyle(items[2]).direction !== 'rtl' ||
      getComputedStyle(items[3]).direction !== 'ltr'
    ) {
      throw new Error('List markers have the wrong direction')
    }
    assertAligned(frame.querySelector('h1')!, 'rtl')
    frame
      .querySelectorAll('th, td')
      .forEach((cell, index) => assertAligned(cell, index % 2 === 0 ? 'rtl' : 'ltr'))
    const code = frame.querySelector('pre')!
    if (getComputedStyle(code).direction !== 'ltr') {
      throw new Error('Code direction changed')
    }
    assertAligned(code, 'ltr')
    const buttons = frame.querySelectorAll('button')
    Array.from(buttons)
      .find((b) => b.textContent === 'Append Persian response')!
      .click()
    Array.from(buttons)
      .find((b) => b.textContent === 'Replace draft')!
      .click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    assertAligned(frame.querySelector('[data-bidi-stream] p')!, 'rtl')
    assertAligned(composer.querySelector('p')!, 'rtl')
    if (composer.textContent !== 'سلام Orca؛ آماده است.') {
      throw new Error('Draft text changed')
    }
  }
})
