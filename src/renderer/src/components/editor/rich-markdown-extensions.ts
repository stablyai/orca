import type { AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import type { DOMOutputSpec } from '@tiptap/pm/model'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableRow } from '@tiptap/extension-table-row'
import { Markdown } from '@tiptap/markdown'
import { getMarkdownPreviewImageSrc } from './markdown-preview-links'
import { RawMarkdownHtmlBlock, RawMarkdownHtmlInline } from './raw-markdown-html'

const RICH_MARKDOWN_PLACEHOLDER = 'Write markdown… Type / for blocks.'

export function createRichMarkdownExtensions({
  includePlaceholder = false
}: {
  includePlaceholder?: boolean
} = {}): AnyExtension[] {
  const extensions: AnyExtension[] = [
    // Why: rich-mode detection must use the exact same markdown extension set as
    // the live editor. If these drift, Orca can claim a document is editable in
    // preview and then still lose syntax on save.
    StarterKit.configure({
      link: false
    }),
    Link.configure({
      openOnClick: false
    }),
    // Why: the default Image extension renders <img src="image.png"> which
    // resolves against the app origin (localhost), not the file system. This
    // custom extension overrides renderHTML to resolve relative src values to
    // file:// URLs using the exact same resolver as preview mode, so nested
    // paths and Windows drive roots stay consistent across both surfaces.
    Image.extend({
      addStorage() {
        return { filePath: '' }
      },
      renderHTML({ HTMLAttributes }) {
        const src = HTMLAttributes.src as string | undefined
        const filePath = this.storage.filePath as string
        const resolvedSrc = filePath ? getMarkdownPreviewImageSrc(src, filePath) : src
        return ['img', { ...HTMLAttributes, src: resolvedSrc }] satisfies DOMOutputSpec
      }
    }).configure({
      allowBase64: true
    }),
    TaskList,
    TaskItem.configure({
      nested: true
    }),
    Table.configure({
      resizable: false
    }),
    TableRow,
    TableHeader,
    TableCell,
    RawMarkdownHtmlInline,
    RawMarkdownHtmlBlock,
    Markdown.configure({
      markedOptions: {
        gfm: true
      }
    })
  ]

  if (includePlaceholder) {
    extensions.push(
      Placeholder.configure({
        placeholder: RICH_MARKDOWN_PLACEHOLDER
      })
    )
  }

  return extensions
}
