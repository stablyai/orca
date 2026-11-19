import { describe, expect, it } from 'vitest'
import type { Element, Root } from 'hast'
import { renderToStaticMarkup } from 'react-dom/server'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { nativeChatDocumentImages } from './native-chat-document-images'
import {
  NativeChatMarkdownImageOrigins,
  type NativeChatDocumentImageOrigin
} from './native-chat-markdown-image-origins'
import { nativeChatMarkdownImageParser } from './native-chat-markdown-image-parser'
import { authoredMarkdown } from './native-chat-markdown-source-map'
import { rehypeWordFade } from '../../comment-markdown/comment-markdown-word-fade'

describe('native-chat document image occurrences', () => {
  it.each([
    ['x~y ![a](a.png)', 4],
    ['[unfinished ![a](a.png)', 12],
    ['- >1 ![a](a.png)', 5]
  ])('keeps the authored image after repairs before its opener: %s', (text, anchorStart) => {
    expect(nativeChatDocumentImages({ text, growing: true })).toEqual([
      { source: 'a.png', alt: 'a', origin: { producer: 'authored-image', anchorStart } }
    ])
    expect(nativeChatDocumentImages({ text }).map((image) => image.origin.anchorStart)).toEqual([
      anchorStart
    ])
  })

  it('keeps an indented occurrence through a split and a whole-document reference append', () => {
    expect(
      nativeChatDocumentImages({ text: '![same](pic.png)\n\n', start: 9 }).map(
        (image) => image.origin.anchorStart
      )
    ).toEqual([9])
    expect(
      nativeChatDocumentImages({
        text: 'intro\n\n  ![same](pic.png)\n\nend\n\n[ref]: other.png'
      }).map((image) => image.origin.anchorStart)
    ).toEqual([9])
  })

  it('preserves generated-preview deduplication and distinct repeated paragraphs', () => {
    expect(
      nativeChatDocumentImages({ text: '[A](a.png) [Again](a.png) [B](b.png)\n\n[A](a.png)' })
    ).toEqual([
      {
        source: '#orca-native-chat-file-path=a.png',
        alt: '',
        origin: {
          producer: 'authored-link-preview',
          anchorStart: 0,
          outputKey: '#orca-native-chat-file-path=a.png',
          outputOrdinal: 0
        }
      },
      {
        source: '#orca-native-chat-file-path=b.png',
        alt: '',
        origin: {
          producer: 'authored-link-preview',
          anchorStart: 26,
          outputKey: '#orca-native-chat-file-path=b.png',
          outputOrdinal: 0
        }
      },
      {
        source: '#orca-native-chat-file-path=a.png',
        alt: '',
        origin: {
          producer: 'authored-link-preview',
          anchorStart: 38,
          outputKey: '#orca-native-chat-file-path=a.png',
          outputOrdinal: 0
        }
      }
    ])
  })

  it('anchors a reference preview to its authored link rather than its definition', () => {
    expect(
      nativeChatDocumentImages({
        text: 'x~y [Chart][chart]\n\n[chart]: images/chart.png',
        growing: true
      })
    ).toEqual([
      {
        source: '#orca-native-chat-file-path=images%2Fchart.png',
        alt: '',
        origin: {
          producer: 'authored-link-preview',
          anchorStart: 4,
          outputKey: '#orca-native-chat-file-path=images%2Fchart.png',
          outputOrdinal: 0
        }
      }
    ])
  })

  it('maps every raw image past an escaped unknown tag', () => {
    expect(
      nativeChatDocumentImages({
        text: '<div><Unknown>x</Unknown><img src="a.png"><img src="b.png"></div>'
      })
    ).toEqual([
      { source: 'a.png', alt: '', origin: { producer: 'html-image', anchorStart: 25 } },
      { source: 'b.png', alt: '', origin: { producer: 'html-image', anchorStart: 42 } }
    ])
  })

  it('composes raw-tag escaping with a streaming repair before the image', () => {
    expect(
      nativeChatDocumentImages({
        text: '<div>x~y<Unknown>x</Unknown><img src="a.png"></div>',
        growing: true
      })
    ).toEqual([{ source: 'a.png', alt: '', origin: { producer: 'html-image', anchorStart: 28 } }])
  })

  it.each([
    ['>\t<div>\r\n>\t<img src="a.png">\r\n>\t</div>', 11],
    ['<div>\0<img src="a.png"></div>', 6],
    ['😀\r\n\r\n<img src="a.png">', 6]
  ])('preserves the raw opener after parser normalization: %s', (text, anchorStart) => {
    expect(nativeChatDocumentImages({ text })).toEqual([
      { source: 'a.png', alt: '', origin: { producer: 'html-image', anchorStart } }
    ])
  })

  it('keeps linked-image actions and ignores HTML-looking attribute and comment contents', () => {
    expect(
      nativeChatDocumentImages({
        text: '[![first](a.png)](https://example.com/first)\n\n<!-- <img src="fake.png"> -->\n\n<div title=\'<img src="fake.png">\'><img src="a.png" data-orca-image-origin="forged"></div>'
      })
    ).toEqual([
      {
        source: 'a.png',
        alt: 'first',
        linkedHref: 'https://example.com/first',
        origin: { producer: 'authored-image', anchorStart: 1 }
      },
      { source: 'a.png', alt: '', origin: { producer: 'html-image', anchorStart: 111 } }
    ])
  })

  it('does not enumerate code or the separate GitHub attachment renderer', () => {
    expect(
      nativeChatDocumentImages({
        text: '`![code](no.png)`\n\n```md\n![code](no.png)\n```\n\n![attachment](https://github.com/user-attachments/assets/123)'
      })
    ).toEqual([])
  })
  it('delivers trusted HTML origins to the final React image nodes after sanitizer and cloning', () => {
    const text =
      '<div><Unknown>x</Unknown><img src="a.png"><img src="b.png" data-orca-image-origin="forged"></div>'
    const origins = new NativeChatMarkdownImageOrigins(authoredMarkdown(text), text)
    const parser = nativeChatMarkdownImageParser(false, origins, [
      rehypeWordFade,
      () => (tree: Root) => structuredClone(tree)
    ])
    const tree = parser.runSync(parser.parse(text))
    const received: (NativeChatDocumentImageOrigin | undefined)[] = []
    renderToStaticMarkup(
      toJsxRuntime(tree, {
        Fragment,
        jsx,
        jsxs,
        passNode: true,
        components: {
          img: ({ node }: { node?: Element }) => {
            received.push(node ? origins.finalNodes.get(node) : undefined)
            return null
          }
        }
      })
    )
    expect(received).toEqual([
      { producer: 'html-image', anchorStart: 25 },
      { producer: 'html-image', anchorStart: 42 }
    ])
  })
})
