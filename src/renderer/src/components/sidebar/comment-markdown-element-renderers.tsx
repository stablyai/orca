import React from 'react'
import type { Components } from 'react-markdown'
import { isMermaidFence, isMermaidPre, renderMermaidFence } from './comment-mermaid-fence'
import {
  GitHubUserAttachmentVideo,
  isGitHubUserAttachmentVideoLink
} from './comment-markdown-github-attachment-video'

export type CommentMarkdownLinkClickHandler = (
  event: React.MouseEvent<HTMLElement>,
  href: string | undefined
) => void

export function isTrustedCompactImageSrc(src: string | undefined): src is string {
  if (!src) {
    return false
  }
  const normalized = src.trim().toLowerCase()
  return (
    normalized.startsWith('blob:') || /^data:image\/(?:png|jpe?g|gif|webp);base64,/.test(normalized)
  )
}

function handleMarkdownAnchorClick(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): void {
  // Why: link clicks should not also trigger an outer row/card click handler;
  // images only claim the click when an image handler is wired below.
  event.stopPropagation()
  if (href?.trim().toLowerCase().startsWith('file:')) {
    event.preventDefault()
  }
  onLinkClick?.(event, href)
}

function handleMarkdownImageClick(
  event: React.MouseEvent<HTMLImageElement>,
  src: string | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): void {
  if (!onLinkClick) {
    return
  }
  event.stopPropagation()
  onLinkClick(event, src)
}

export function createCompactCommentMarkdownComponents(
  onLinkClick?: CommentMarkdownLinkClickHandler
): Components {
  return {
    // Strip <p> wrappers to avoid double margins in the tight card layout.
    p: ({ children }) => <span className="comment-md-p">{children}</span>,
    // Open links externally — sidebar is not a navigation context.
    a: ({ href, children }) => (
      <a
        href={href || undefined}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
        onClick={(e) => handleMarkdownAnchorClick(e, href, onLinkClick)}
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
    // Why: compact comment previews live in dense cards; keep diagram fences as
    // bounded source blocks so async SVG renders do not reshape sidebar lists.
    code: ({ children }) => (
      <code className="rounded bg-accent px-1 py-px text-[10px] font-mono [overflow-wrap:anywhere]">
        {children}
      </code>
    ),
    // Compact pre blocks — no syntax highlighting needed for short comments.
    pre: ({ children }) => (
      <pre className="my-1 max-h-32 max-w-full overflow-x-auto rounded bg-accent p-1.5 text-[10px] font-mono">
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
    // Why: agent replies and workspace notes often carry screenshot markdown
    // like "Image #1"; compact cards inline app-managed thumbnails without
    // auto-fetching arbitrary remote image URLs.
    img: ({ alt, src }) => {
      if (!isTrustedCompactImageSrc(src)) {
        if (!src) {
          return alt ? <span>{alt}</span> : null
        }
        return (
          <a
            href={src || undefined}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
            onClick={(e) => handleMarkdownAnchorClick(e, src, onLinkClick)}
          >
            {alt || src}
          </a>
        )
      }

      const image = (
        <img
          src={src}
          alt={alt ?? ''}
          className="my-1 max-h-32 max-w-full rounded-sm object-contain outline outline-1 outline-border/70"
        />
      )
      return src ? (
        <a
          href={src || undefined}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => handleMarkdownAnchorClick(e, src, onLinkClick)}
        >
          {image}
        </a>
      ) : (
        image
      )
    },
    // Why: GFM tables in a ~200px sidebar would overflow badly. Wrapping in an
    // overflow container keeps the card layout stable while still letting the
    // user scroll to see the full table.
    table: ({ children }) => (
      <div className="my-1 max-w-full overflow-x-auto">
        <table className="text-[10px] border-collapse [&_td]:border [&_td]:border-border/40 [&_td]:px-1 [&_td]:py-0.5 [&_th]:border [&_th]:border-border/40 [&_th]:px-1 [&_th]:py-0.5 [&_th]:font-semibold [&_th]:text-left">
          {children}
        </table>
      </div>
    )
  }
}

export function createDocumentCommentMarkdownComponents(
  onLinkClick?: CommentMarkdownLinkClickHandler
): Components {
  return {
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    a: ({ href, children }) =>
      isGitHubUserAttachmentVideoLink(href, children) ? (
        // Why: GitHub's API returns uploaded videos as bare attachment links;
        // GitHub.com upgrades them to media embeds in its own renderer.
        <GitHubUserAttachmentVideo href={href}>{children}</GitHubUserAttachmentVideo>
      ) : (
        <a
          href={href || undefined}
          target="_blank"
          rel="noreferrer"
          className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
          onClick={(e) => handleMarkdownAnchorClick(e, href, onLinkClick)}
        >
          {children}
        </a>
      ),
    code: ({ className, children }) =>
      isMermaidFence(className) ? (
        renderMermaidFence(
          children,
          'my-3 min-w-0 max-w-full overflow-x-auto rounded-md border border-border/60 p-3 [&_.mermaid-block]:min-w-0 [&_.mermaid-block_pre]:my-0 [&_.mermaid-block_pre]:max-h-80 [&_.mermaid-block_pre]:max-w-full [&_.mermaid-block_pre]:overflow-x-auto [&_.mermaid-block_pre]:rounded-md [&_.mermaid-block_pre]:bg-accent [&_.mermaid-block_pre]:p-3 [&_.mermaid-block_pre]:font-mono [&_.mermaid-block_pre]:text-[12px]'
        )
      ) : (
        <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">
          {children}
        </code>
      ),
    // Mermaid fences render a <div>, which is invalid inside <pre>, so unwrap them.
    pre: ({ children }) =>
      isMermaidPre(children) ? (
        <>{children}</>
      ) : (
        <pre className="my-3 max-h-80 max-w-full overflow-x-auto rounded-md bg-accent p-3 font-mono text-[12px]">
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
    img: ({ alt, src }) => {
      const imageClassName = [
        'my-3 max-h-96 max-w-full rounded-md object-contain',
        'outline outline-1 outline-black/10 dark:outline-white/10',
        onLinkClick ? 'cursor-pointer' : ''
      ]
        .filter(Boolean)
        .join(' ')

      return (
        <img
          src={src}
          alt={alt ?? ''}
          className={imageClassName}
          onClick={(e) => handleMarkdownImageClick(e, src, onLinkClick)}
        />
      )
    },
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
}

export const compactCommentMarkdownComponents: Components = createCompactCommentMarkdownComponents()
export const documentCommentMarkdownComponents: Components =
  createDocumentCommentMarkdownComponents()
