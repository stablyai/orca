import { createElement, type ElementType, type HTMLAttributes } from 'react'
import { defaultSchema } from 'rehype-sanitize'
import { Image as ImageIcon } from 'lucide-react'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import { createCompactCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'
import { translate } from '@/i18n/i18n'

// Why: previewed files are untrusted, so no image source may start a file or network read.
function InertMarkdownImage({ alt }: { alt?: string }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 align-baseline text-muted-foreground">
      <ImageIcon aria-hidden="true" className="size-3 shrink-0" />
      {alt || translate('terminal.filePeek.markdownImage', 'Image')}
    </span>
  )
}

// Why: a peeked link must not leave the terminal's context; its text stays readable.
function InertMarkdownLink({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <span className="underline underline-offset-2 text-foreground/80">{children}</span>
}

function InertMarkdownBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div>{children}</div>
}

function InertMarkdownSummary({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div className="font-semibold">{children}</div>
}

function InertMarkdownInline({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <span>{children}</span>
}

const compactComponents: Readonly<Record<string, ElementType>> =
  createCompactCommentMarkdownComponents()

// The shared schema allows tabIndex/accessKey globally, even on otherwise passive tags.
const passiveComponents = Object.fromEntries(
  (defaultSchema.tagNames ?? []).map((tagName) => {
    const Component = compactComponents[tagName] ?? tagName
    return [
      tagName,
      function PassiveMarkdownElement({
        node,
        tabIndex: _tabIndex,
        accessKey: _accessKey,
        contentEditable: _contentEditable,
        ...props
      }: HTMLAttributes<HTMLElement> & { node?: unknown }) {
        return createElement(Component, typeof Component === 'string' ? props : { ...props, node })
      }
    ]
  })
)

/** Module-level so the markdown components stay stable between renders. */
export const TERMINAL_FILE_PEEK_MARKDOWN_EXTENSION: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components: {
    ...passiveComponents,
    img: InertMarkdownImage,
    a: InertMarkdownLink,
    details: InertMarkdownBlock,
    summary: InertMarkdownSummary,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} disabled readOnly />,
    picture: InertMarkdownInline,
    source: () => null
  }
}
