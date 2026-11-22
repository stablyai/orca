// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { markdownMathSelectionText } from './markdown-math-selection'

const formula = '<span data-math-source="$x^2$"><span aria-hidden="true">x2</span></span>'
const displayFormula = (source: string) =>
  `<span data-math-source="${source}" class="block"><span aria-hidden="true">x</span></span>`

// happy-dom has no user-agent stylesheet; a browser's keeps pre content as written.
document.head.innerHTML = '<style>pre { white-space: pre } .block { display: block }</style>'

function copiedText(html: string): string | null {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.replaceChildren(root)
  const selection = document.getSelection()
  selection?.selectAllChildren(root)
  return selection && markdownMathSelectionText(selection, root)
}

// Expected texts are Chromium's own Selection.toString() of the same markup, formula aside.
describe('markdownMathSelectionText', () => {
  it.each([
    {
      name: 'nested wrappers and inter-block whitespace',
      html: `<div><p>Inline ${formula} here.</p>\n<ul>\n<li><div><p>one</p></div></li>\n<li><div><p>two</p></div></li>\n</ul>\n<blockquote>\n<p>quoted one</p>\n<p>quoted <em>two</em> <strong>words</strong></p>\n</blockquote>\n<h2>Heading</h2>\n<dl>\n<dt>term</dt>\n<dd>def</dd>\n</dl>\n<details open>\n<summary>sum</summary>\nbody text\n</details></div>`,
      text: 'Inline $x^2$ here.\n\none\n\ntwo\n\nquoted one\n\nquoted two words\n\nHeading\nterm\ndef\nsum\nbody text'
    },
    {
      name: 'trailing empty table cells',
      html: `<p>${formula}</p><table><tr><td>A</td><td></td><td></td></tr><tr><td>B</td><td></td><td></td></tr></table>`,
      text: '$x^2$\n\nA\t\t\nB\t\t'
    },
    {
      name: 'fully empty last table row',
      html: `<p>${formula}</p><table><tr><td>A</td><td>b</td><td>c</td></tr><tr><td></td><td></td><td></td></tr></table>`,
      text: '$x^2$\n\nA\tb\tc'
    },
    {
      name: 'preformatted code',
      html: `<div><p>${formula}</p>\n<div><div>TypeScript</div><pre><code>  if (a) {\n\n    b()\n  }\n</code></pre></div>\n<p>after</p></div>`,
      text: '$x^2$\n\nTypeScript\n  if (a) {\n\n    b()\n  }\nafter'
    },
    {
      name: 'adjacent display formulas',
      html: `<div><p>before</p>\n${displayFormula('$$a$$')}\n${displayFormula('$$b$$')}${displayFormula('$$c$$')}\n<ul>\n<li>intro\n${displayFormula('$$d$$')}</li>\n</ul></div>`,
      text: 'before\n\n$$a$$\n$$b$$\n$$c$$\nintro\n$$d$$'
    }
  ])('separates blocks like native copy: $name', ({ html, text }) => {
    expect(copiedText(html)).toBe(text)
  })
})
