import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const CASES = [
  '[Issue شمارهٔ ۱۲۳](https://example.com/issues/123) ثبت شد. این یک متن آزمایشی فارسی با واژهٔ English است و عبارت `Co-authored-by` هم باید خوانا بماند. پایان جمله نباید به ابتدای سطر منتقل شود.',
  '[PR شمارهٔ ۴۵۶](https://example.com/pull/456) منتشر شد. فایل‌های renderer و Markdown در این نمونه بررسی می‌شوند و نام `example-user` نیز باید خوانا بماند.',
  '[Issue #123](https://example.com/issues/123) is open. This English paragraph stays left aligned, including words مثل فارسی.',
  'این [راهنمای فارسی؛ آماده‌ای؟](https://example.com/help) برای متن فارسی و English است.',
  '[راهنمای فارسی؛ آماده‌ای؟](https://example.com/help)',
  'English text with [راهنمای فارسی؛ آماده‌ای؟](https://example.com/help) stays on the left.',
  '**[راهنمای فارسی؛ آماده‌ای؟](https://example.com/help)**',
  '**[Issue #123](https://example.com/issues/123) ثبت شد. این نمونه با English ترکیب شده است.**',
  '[مرجع عربي](https://example.com/help) جاهز. هذه فقرة عربية تتضمن Orca وEnglish وتبقى محاذاة النص إلى اليمين.'
]
const DIRECTIONS = ['rtl', 'rtl', 'ltr', 'rtl', 'rtl', 'ltr', 'rtl', 'rtl', 'rtl'] as const

function References(): React.JSX.Element {
  return (
    <div className="native-chat-appearance space-y-4 p-4">
      {[false, true].map((fadeWords) => (
        <section key={String(fadeWords)} data-reference-fade={String(fadeWords)}>
          {CASES.map((content, index) => (
            <div key={content} data-reference-case={index}>
              <NativeChatMarkdown
                variant="document"
                content={content}
                fadeFrom={fadeWords ? 0 : undefined}
                streaming={fadeWords}
              />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function characterBox(element: Element, offset: number): DOMRect {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode
    const length = node.textContent!.length
    if (offset < length) {
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      return range.getBoundingClientRect()
    }
    offset -= length
  }
  throw new Error('Missing reference character')
}

function assertReferences(frame: HTMLElement): void {
  const paragraphs = frame.querySelectorAll('[data-reference-case] p')
  if (paragraphs.length !== CASES.length * 2) {
    throw new Error('Missing reference paragraphs')
  }
  for (const p of paragraphs) {
    const index = Number(p.parentElement!.parentElement!.getAttribute('data-reference-case'))
    const direction = DIRECTIONS[index]
    const range = document.createRange()
    range.selectNodeContents(p)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
    const bottom = Math.max(...rects.map((r) => r.bottom))
    const line = rects.filter((r) => Math.abs(r.bottom - bottom) < 2)
    const box = p.getBoundingClientRect()
    const gap =
      direction === 'rtl'
        ? box.right - Math.max(...line.map((r) => r.right))
        : Math.min(...line.map((r) => r.left)) - box.left
    const link = p.querySelector('a')!
    if (
      /^(Issue|PR)/u.test(link.textContent!) &&
      characterBox(link, 0).left >= characterBox(link, 1).left
    ) {
      throw new Error('English reference label reversed')
    }
    if (
      link.textContent!.endsWith('؟') &&
      characterBox(link, link.textContent!.length - 1).left >= characterBox(link, 0).left
    ) {
      throw new Error('Persian link punctuation moved to its leading edge')
    }
    p.querySelectorAll('code').forEach((code) => {
      if (getComputedStyle(code).direction !== 'ltr') {
        throw new Error('Inline command direction changed')
      }
    })
    if (Math.abs(gap) > 3) {
      throw new Error(`Reference paragraph ${index} must align ${direction}, gap=${gap}`)
    }
  }
  if (!frame.querySelector('[data-reference-fade="true"] [data-word-group]')) {
    throw new Error('Word-fade rendering path was not exercised')
  }
}

export const preview = defineFixture({ width: 900, render: () => <References /> })
export const narrow = defineFixture({
  width: 360,
  render: () => <References />,
  interact: assertReferences
})
export const wide = defineFixture({
  width: 900,
  render: () => <References />,
  interact: assertReferences
})
