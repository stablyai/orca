// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { TerminalFileContext } from '../terminal-file-path-mapping'
import { TerminalFilePeekBody } from './TerminalFilePeekBody'

afterEach(cleanup)

const FILE_CONTEXT: TerminalFileContext = {
  target: { kind: 'local' },
  worktreeId: 'worktree-1',
  worktreePath: '/repo',
  sourceHostResolved: true
}
const JIRA_IMAGE = 'orca-jira-image://attachment/0a1b2c3d-0a1b-4c3d-8a1b-0a1b2c3d4e5f'
const ACTIVE_CONTENT =
  'a,button,input:not([disabled]),select,textarea,summary,details,[tabindex],[contenteditable],[accesskey],img,video,audio,source,picture,iframe,embed,object'

function renderPeek(source: string): HTMLElement {
  return render(
    <TerminalFilePeekBody
      content={{ kind: 'markdown', path: '/repo/README.md', source }}
      fileContext={FILE_CONTEXT}
    />
  ).container
}

describe('terminal file peek markdown', () => {
  it('renders a trusted compact image as an img without the peek extension', () => {
    const { container } = render(
      <CommentMarkdown variant="compact" content={`![jira](${JIRA_IMAGE})`} />
    )

    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it.each([
    ['an HTTP image', '![remote shot](https://example.com/shot.png)', 'remote shot'],
    ['a relative local image', '![local shot](./docs/shot.png)', 'local shot'],
    ['a raw HTML image', '<img src="https://example.com/raw.png" alt="raw shot">', 'raw shot'],
    ['a relative raw HTML image', '<img src="./docs/raw.png" alt="raw local">', 'raw local'],
    ['a Jira image reference', `![jira shot](${JIRA_IMAGE})`, 'jira shot'],
    ['an inline data image', '![data shot](data:image/png;base64,iVBORw0KGgo=)', 'data shot'],
    [
      'a reference-style image',
      '![ref shot][shot]\n\n[shot]: https://example.com/ref.png',
      'ref shot'
    ],
    [
      'an image inside a link',
      '[![badge](https://example.com/badge.svg)](https://example.com)',
      'badge'
    ]
  ])('renders no img for %s and keeps its alt text', (_name, source, alt) => {
    const container = renderPeek(source)

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.textContent).toContain(alt)
  })

  it.each([
    ['a markdown link', '[docs](https://example.com/docs)', 'docs'],
    ['a raw HTML link', '<a href="https://example.com/raw">raw docs</a>', 'raw docs'],
    ['a bare URL', 'See https://example.com/bare for more', 'https://example.com/bare'],
    ['a file link', '[notes](file:///repo/notes.md)', 'notes']
  ])('renders %s as inert text', (_name, source, text) => {
    const container = renderPeek(source)

    expect(container.querySelectorAll('a, [href]')).toHaveLength(0)
    expect(container.textContent).toContain(text)
  })

  it.each([
    [
      'a closed disclosure',
      '<details><summary>Read more</summary><p>Expanded content</p></details>',
      ['Read more', 'Expanded content']
    ],
    [
      'an open disclosure',
      '<details open><summary>Open summary</summary><p>Open content</p></details>',
      ['Open summary', 'Open content']
    ],
    [
      'Markdown task lists',
      '- [ ] Pending task\n- [x] Finished task',
      ['Pending task', 'Finished task']
    ],
    [
      'raw HTML inputs',
      '<input type="text"><input type="checkbox" checked>Task label',
      ['Task label']
    ],
    [
      'a responsive image',
      '<picture><source srcset="https://example.com/large.png 2x"><img src="https://example.com/small.png" alt="Responsive shot"></picture>',
      ['Responsive shot']
    ],
    [
      'form controls',
      '<button>Button label</button><select><option>Selection text</option></select><textarea>Text entry</textarea>',
      ['Button label', 'Selection text', 'Text entry']
    ],
    [
      'media and embedded resources',
      '<video controls src="https://example.com/video.mp4">Video fallback</video><audio controls src="https://example.com/audio.mp3">Audio fallback</audio><iframe src="https://example.com">Frame fallback</iframe><embed src="https://example.com/embed"><object data="https://example.com/object">Object fallback</object>',
      ['Video fallback', 'Audio fallback', 'Frame fallback', 'Object fallback']
    ],
    [
      'focus and editing attributes on otherwise passive HTML',
      '<div tabindex="0" accesskey="d" contenteditable="true"><span tabindex="1">Span text</span><strong tabindex="2">Strong text</strong><section tabindex="0">Section text</section><table tabindex="0"><tbody><tr tabindex="0"><td tabindex="0">Cell text</td></tr></tbody></table></div>',
      ['Span text', 'Strong text', 'Section text', 'Cell text']
    ],
    [
      'Markdown links, footnotes and images',
      '[Docs](https://example.com) ![Shot](https://example.com/shot.png) Note[^one]\n\n[^one]: Footnote text',
      ['Docs', 'Shot', 'Footnote text']
    ]
  ])('keeps %s passive and preserves its text', (_name, source, texts) => {
    const container = renderPeek(source)

    const scroller = container.querySelector('.overflow-y-auto')
    expect(scroller?.getAttribute('tabindex')).toBe('-1')
    expect(scroller?.querySelectorAll(ACTIVE_CONTENT)).toHaveLength(0)
    for (const text of texts) {
      expect(container.textContent).toContain(text)
    }
    for (const input of container.querySelectorAll('input')) {
      expect(input.disabled).toBe(true)
      expect(input.type).toBe('checkbox')
    }
  })

  it('shows a generic label for an image without alt text', () => {
    const container = renderPeek('![](https://example.com/unnamed.png)')

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.textContent).toContain('Image')
  })

  it('renders fences as plain code and keeps math delimiters literal', () => {
    const container = renderPeek('```mermaid\nflowchart TD\n A --> B\n```\n\n$x^2$')

    expect(container.querySelector('pre code')?.textContent).toContain('flowchart TD')
    expect(container.textContent).toContain('$x^2$')
  })
})
