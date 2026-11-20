import { describe, expect, it } from 'vitest'
import { isEditableDetailsHtmlBlock, matchDetailsHtmlBlock } from './details-markdown-html'

function nestedToggles(depth: number): string {
  let html = '<details class="orca-details" open>\n<summary>leaf</summary>\n\nBody\n\n</details>'
  for (let level = depth - 1; level > 0; level -= 1) {
    html = `<details class="orca-details" open>\n<summary>level ${level}</summary>\n\n${html}\n\n</details>`
  }
  return html
}

function isEditableHtml(html: string): boolean {
  const block = matchDetailsHtmlBlock(html, 0)
  return block !== null && isEditableDetailsHtmlBlock(block)
}

describe('details markdown html', () => {
  it('bounds each of many sibling nested toggles independently', () => {
    const siblings = (count: number, extra = ''): string =>
      Array.from(
        { length: count },
        (_, index) =>
          `<details class="orca-details"${extra}>\n<summary>sibling ${index}</summary>\n\nBody\n\n</details>`
      ).join('\n\n')
    const wrap = (body: string): string =>
      `<details class="orca-details">\n<summary>Outer</summary>\n\n${body}\n\n</details>`

    expect(isEditableHtml(wrap(siblings(40)))).toBe(true)
    // Shared fence ranges must not let later siblings inherit an earlier sibling’s editability boundaries.
    expect(isEditableHtml(wrap(`${siblings(20)}\n\n${siblings(1, ' id="x"')}`))).toBe(false)
  })

  it('rejects nesting past the recursion guard instead of recursing without bound', () => {
    expect(isEditableHtml(nestedToggles(17))).toBe(false)
    expect(isEditableHtml(nestedToggles(400))).toBe(false)
  })
})
