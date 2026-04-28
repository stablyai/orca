import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Components } from 'react-markdown'
import { cn } from '@/lib/utils'

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>

// Why: sidebar comments are rendered at 11px in a narrow card, so we strip
// block-level wrappers that add unwanted margins and only keep inline
// formatting (bold, italic, code, links) plus compact lists and line breaks.
// Using react-markdown (already a project dependency) lets AI agents write
// markdown via `orca worktree set --comment` and have it render nicely.

const compactComponents: Components = {
  // Strip <p> wrappers to avoid double margins in the tight card layout.
  p: ({ children }) => <span className="comment-md-p">{children}</span>,
  // Open links externally — sidebar is not a navigation context.
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  ),
  // Why: react-markdown calls the `code` component for both inline `code`
  // and the <code> inside fenced blocks (<pre><code>…</code></pre>). We
  // always apply inline-code styling here; the wrapper div uses a CSS
  // descendant selector ([&_pre_code]) at higher specificity to strip
  // the pill background/padding when code is inside a <pre>. This is
  // more reliable than checking `className` — which is only set when
  // the fenced block specifies a language (```js), not for bare ```.
  code: ({ children }) => (
    <code className="rounded bg-accent px-1 py-px text-[10px] font-mono">{children}</code>
  ),
  // Compact pre blocks — no syntax highlighting needed for short comments
  pre: ({ children }) => (
    <pre className="my-1 rounded bg-accent p-1.5 text-[10px] font-mono overflow-x-auto max-h-32">
      {children}
    </pre>
  ),
  // Compact lists
  ul: ({ children }) => <ul className="my-0.5 ml-3 list-disc space-y-0">{children}</ul>,
  ol: ({ children }) => <ol className="my-0.5 ml-3 list-decimal space-y-0">{children}</ol>,
  // Why: GFM task list checkboxes are non-functional in a read-only comment
  // card (clicking them would just open the edit modal via the parent's
  // onClick). Rendering them disabled avoids a misleading interactive
  // affordance.
  li: ({ children }) => (
    <li className="leading-normal [&>input]:pointer-events-none">{children}</li>
  ),
  // Headings render as bold text at the same size — no visual hierarchy needed
  // in a tiny sidebar card.
  h1: ({ children }) => <span className="font-bold">{children}</span>,
  h2: ({ children }) => <span className="font-bold">{children}</span>,
  h3: ({ children }) => <span className="font-semibold">{children}</span>,
  h4: ({ children }) => <span className="font-semibold">{children}</span>,
  h5: ({ children }) => <span className="font-semibold">{children}</span>,
  h6: ({ children }) => <span className="font-semibold">{children}</span>,
  // Horizontal rules as a subtle divider
  hr: () => <hr className="my-1 border-border/50" />,
  // Compact blockquotes
  blockquote: ({ children }) => (
    <blockquote className="my-0.5 border-l-2 border-border/60 pl-2 text-muted-foreground/80">
      {children}
    </blockquote>
  ),
  // Why: images in a ~200px sidebar card would blow out the layout or look
  // broken at any reasonable size. Render as a text link instead so the URL is
  // still accessible without disrupting the card.
  img: ({ alt, src }) => (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      {alt || 'image'}
    </a>
  ),
  // Why: GFM tables in a ~200px sidebar would overflow badly. Wrapping in an
  // overflow container keeps the card layout stable while still letting the
  // user scroll to see the full table.
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="text-[10px] border-collapse [&_td]:border [&_td]:border-border/40 [&_td]:px-1 [&_td]:py-0.5 [&_th]:border [&_th]:border-border/40 [&_th]:px-1 [&_th]:py-0.5 [&_th]:font-semibold [&_th]:text-left">
        {children}
      </table>
    </div>
  )
}

const documentComponents: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-[0.92em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 max-h-80 overflow-x-auto rounded-md bg-accent p-3 font-mono text-[12px]">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
  li: ({ children }) => (
    <li className="leading-relaxed [&>input]:pointer-events-none">{children}</li>
  ),
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-[18px] font-semibold leading-tight first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-4 text-[16px] font-semibold leading-tight first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-3 text-[15px] font-semibold leading-tight first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => <h4 className="mb-1 mt-3 font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-3 font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-3 font-semibold first:mt-0">{children}</h6>,
  hr: () => <hr className="my-4 border-border/60" />,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-border/70 pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  img: ({ alt, src }) => (
    <img
      src={src}
      alt={alt ?? ''}
      className="my-3 max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-black/10 dark:outline-white/10"
    />
  ),
  // Why: GitHub issue/PR bodies commonly contain GFM tables. The dashboard
  // dialog is wide enough to show them, but still needs overflow containment.
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-md border border-border/60">
      <table className="min-w-full border-collapse text-[13px] [&_td]:border [&_td]:border-border/50 [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-border/50 [&_th]:bg-muted/60 [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold">
        {children}
      </table>
    </div>
  )
}

// Why: standard CommonMark collapses single newlines into spaces. The old
// plain-text renderer used whitespace-pre-wrap which preserved them. Adding
// remark-breaks converts single newlines to <br>, keeping backward compat
// with existing plain-text comments that rely on newline formatting.
const remarkPlugins = [remarkGfm, remarkBreaks]

const commentMarkdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'sub', 'sup', 'ins', 'kbd'],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  }
}

// Why: GitHub comments often include safe raw HTML (`<sub>`, `<details>`,
// `<br />`). Parse it, then sanitize immediately before React renders it.
const rehypePlugins: MarkdownPlugins = [rehypeRaw, [rehypeSanitize, commentMarkdownSanitizeSchema]]

type CommentMarkdownProps = React.ComponentPropsWithoutRef<'div'> & {
  content: string
  variant?: 'compact' | 'document'
}

// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdown = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdown(
    { content, className, variant = 'compact', ...rest },
    ref
  ) {
    const components = variant === 'document' ? documentComponents : compactComponents

    return (
      <div
        ref={ref}
        className={cn(
          // Reset inline-code pill styles when <code> is inside a <pre> block.
          // The descendant selector (pre code) has higher specificity than the
          // direct utility classes on <code>, so these overrides win reliably.
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none',
          className
        )}
        {...rest}
      >
        <Markdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {content}
        </Markdown>
      </div>
    )
  })
)

export default CommentMarkdown
