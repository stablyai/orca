import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Root, RootContent } from 'mdast'
import { commentMarkdownRemarkPlugins } from '../../sidebar/comment-markdown-remark-plugins'
import { linkNativeChatFilePaths } from '../../../../../shared/native-chat/native-chat-file-link-tree'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'

// The renderer's plain-text path linking, as CommentMarkdown installs it.
const linkPlainTextPaths = () => (tree: Parameters<typeof linkNativeChatFilePaths>[0]) =>
  linkNativeChatFilePaths(tree, () => true)

/** The transcript's tree for this Markdown; `linkify` adds the renderer's plain-text path links first. */
function transcriptTree(markdown: string, linkify = false): Root {
  const processor = unified()
    .use(remarkParse)
    .use(commentMarkdownRemarkPlugins)
    .use(linkify ? [linkPlainTextPaths] : [])
    .use(remarkNativeChatFileDestinations)
  // Every transformer here edits the tree in place.
  const tree = processor.parse(markdown)
  processor.runSync(tree)
  return tree
}

/** Image sources in document order. */
function imageSources(markdown: string, linkify: boolean): string[] {
  const tree = transcriptTree(markdown, linkify)
  const sources: string[] = []
  function collect(node: Root | RootContent): void {
    if (node.type === 'image') {
      sources.push(node.url)
    }
    if ('children' in node) {
      node.children.forEach(collect)
    }
  }
  collect(tree)
  return sources
}

// Every case ends with a control link, so a case fails if previews stop working at all.
const CONTROL = '\n\n[control](shots/control.png)'
const CONTROL_PREVIEW = '#orca-native-chat-file-path=shots%2Fcontrol.png'

describe('remarkNativeChatFileDestinations linked image previews', () => {
  it.each([
    ['[chart](shots/chart.png)', ['#orca-native-chat-file-path=shots%2Fchart.png']],
    [
      'Done. [Download the edited image](/repo/out.png) and more.',
      ['#orca-native-chat-file-path=%2Frepo%2Fout.png']
    ],
    [
      '- [a](shots/a.webp)\n- [b](shots/b.jpg)',
      ['#orca-native-chat-file-path=shots%2Fa.webp', '#orca-native-chat-file-path=shots%2Fb.jpg']
    ],
    ['[c](file:///repo/c.png)', ['#orca-native-chat-file-path=%2Frepo%2Fc.png']],
    ['[d](shots/d.png#L3)', ['#orca-native-chat-file-path=shots%2Fd.png']],
    ['[e][1]\n\n[1]: shots/e.gif', ['#orca-native-chat-file-path=shots%2Fe.gif']],
    // A literal colon in the filename and a `:line` suffix both leave a non-image extension.
    ['[f](/repo/f.png%3A3)', []],
    ['[g](/repo/g.png:3:4)', []],
    ['[h](https://example.com/h.png)', []],
    ['[i](//example.com/i.png)', []],
    ['[j](\\\\\\\\server\\\\share\\\\j.png)', []],
    ['[k](docs/report.md)', []],
    ['[![l](shots/l.png)](shots/full.png)', ['shots/l.png']],
    ['[m](shots/m.png) [again](shots/m.png)', ['#orca-native-chat-file-path=shots%2Fm.png']],
    ['![n](shots/n.png) [n](shots/n.png)', ['shots/n.png']],
    ['See shots/plain.png and `shots/code.png`.', []]
  ])('%s', (markdown, expected) => {
    // Only what the author wrote decides, so the renderer (which linkifies) and discovery agree.
    expect(imageSources(markdown + CONTROL, false)).toEqual([...expected, CONTROL_PREVIEW])
    expect(imageSources(markdown + CONTROL, true)).toEqual([...expected, CONTROL_PREVIEW])
  })

  it('places the preview after the paragraph that links it and keeps the link', () => {
    const tree = transcriptTree('Before.\n\nSee [chart](shots/chart.png).\n\nAfter.')
    expect(tree.children.map((node) => node.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph'
    ])
    const [, linking, preview] = tree.children
    expect(linking).toMatchObject({ children: [{}, { type: 'link', url: 'shots/chart.png' }, {}] })
    expect(preview).toMatchObject({
      children: [{ type: 'image', url: '#orca-native-chat-file-path=shots%2Fchart.png', alt: '' }]
    })
  })
})
