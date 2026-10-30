import React from 'react'
import { jiraImageReference } from '../../../../shared/jira/jira-attachment-image'
import type { Components } from 'react-markdown'
import { NATIVE_CHAT_FILE_HREF_PREFIX } from '../../../../shared/native-chat/native-chat-href-routing'
import {
  CommentMarkdownDocumentCode,
  CommentMarkdownDocumentPre
} from './comment-markdown-code-renderers'
import {
  GitHubUserAttachmentImage,
  GitHubUserAttachmentVideo,
  isGitHubUserAttachmentUrl,
  isGitHubUserAttachmentVideoLink
} from './comment-markdown-github-attachment-media'
import { ExpandableMarkdownImage } from './MarkdownImageLightbox'
import { MarkdownGitHubCallout } from '@/components/markdown-github-callout'
import { readGitHubCalloutKind } from '@/lib/remark-github-callouts'

export type CommentMarkdownLinkClickHandler = (
  event: React.MouseEvent<HTMLElement>,
  href: string | undefined
) => void

/** Rendered as a component, so it may hold state. */
export type DocumentCodeBlockRenderer = (props: {
  children?: React.ReactNode
  language?: string
  /** Whole-document fence line stays stable while streaming only escapes within lines or appends text. */
  sourceLine?: number
}) => React.JSX.Element

export function isTrustedCompactImageSrc(src: string | undefined): src is string {
  if (!src) {
    return false
  }
  const normalized = src.trim().toLowerCase()
  return (
    jiraImageReference(src) !== null ||
    normalized.startsWith('blob:') ||
    /^data:image\/(?:png|jpe?g|gif|webp);base64,/.test(normalized)
  )
}

function handleMarkdownAnchorClick(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): void {
  // Link clicks must not activate outer cards; images consume clicks only with a wired handler.
  event.stopPropagation()
  const trimmedHref = href?.trim()
  if (
    trimmedHref?.toLowerCase().startsWith('file:') ||
    trimmedHref?.startsWith(NATIVE_CHAT_FILE_HREF_PREFIX)
  ) {
    event.preventDefault()
  }
  onLinkClick?.(event, href)
}

function handleMarkdownAnchorAuxClick(
  event: React.MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): void {
  if (event.button === 1) {
    handleMarkdownAnchorClick(event, href, onLinkClick)
  }
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
  onLinkClick?: CommentMarkdownLinkClickHandler,
  expandImages = false
): Components {
  return {
    // Avoid paragraph margins in dense cards.
    p: ({ children }) => <span className="comment-md-p">{children}</span>,
    a: ({ href, children }) => (
      <a
        href={href || undefined}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 text-foreground/80 hover:text-foreground"
        onClick={(e) => handleMarkdownAnchorClick(e, href, onLinkClick)}
        onAuxClick={(e) => handleMarkdownAnchorAuxClick(e, href, onLinkClick)}
      >
        {children}
      </a>
    ),
    // Bare fences have no language class; style all code inline, then use higher-specificity pre/code overrides for blocks.
    // Keep compact diagrams as bounded source so async SVG cannot reshape sidebar lists.
    code: ({ children }) => (
      <code className="rounded bg-accent px-1 py-px text-[10px] font-mono [overflow-wrap:anywhere]">
        {children}
      </code>
    ),
    pre: ({ children }) => (
      <pre className="my-1 max-h-32 max-w-full overflow-x-auto rounded bg-accent p-1.5 text-[10px] font-mono">
        {children}
      </pre>
    ),
    ul: ({ children }) => <ul className="my-0.5 ml-3 list-disc space-y-0">{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start} className="my-0.5 ml-3 list-decimal space-y-0">
        {children}
      </ol>
    ),
    // Task checkboxes are read-only; pointer input would otherwise activate card editing.
    li: ({ children }) => (
      <li className="leading-normal [&>input]:pointer-events-none">{children}</li>
    ),
    // Preserve compact span flow while heading roles retain navigable hierarchy.
    h1: ({ children }) => (
      <span className="comment-md-h comment-md-h1 font-bold" role="heading" aria-level={1}>
        {children}
      </span>
    ),
    h2: ({ children }) => (
      <span className="comment-md-h comment-md-h2 font-bold" role="heading" aria-level={2}>
        {children}
      </span>
    ),
    h3: ({ children }) => (
      <span className="comment-md-h comment-md-h3 font-semibold" role="heading" aria-level={3}>
        {children}
      </span>
    ),
    h4: ({ children }) => (
      <span className="comment-md-h font-semibold" role="heading" aria-level={4}>
        {children}
      </span>
    ),
    h5: ({ children }) => (
      <span className="comment-md-h font-semibold" role="heading" aria-level={5}>
        {children}
      </span>
    ),
    h6: ({ children }) => (
      <span className="comment-md-h font-semibold" role="heading" aria-level={6}>
        {children}
      </span>
    ),
    hr: () => <hr className="my-1 border-border/50" />,
    blockquote: ({ node, children }) => {
      const calloutKind = readGitHubCalloutKind(node?.properties.dataCallout)
      return calloutKind ? (
        <MarkdownGitHubCallout kind={calloutKind} className="my-0.5 border-l-2 pl-2">
          {children}
        </MarkdownGitHubCallout>
      ) : (
        <blockquote className="my-0.5 border-l-2 border-border/60 pl-2 text-muted-foreground/80">
          {children}
        </blockquote>
      )
    },
    // Inline only app-managed screenshots; avoid fetching arbitrary remote images in compact cards.
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
            onAuxClick={(e) => handleMarkdownAnchorAuxClick(e, src, onLinkClick)}
          >
            {alt || src}
          </a>
        )
      }

      if (expandImages) {
        return (
          <ExpandableMarkdownImage
            src={src}
            alt={alt}
            triggerClassName="my-1"
            className="max-h-32 max-w-full rounded-sm object-contain outline outline-1 outline-border/70"
          />
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
          onAuxClick={(e) => handleMarkdownAnchorAuxClick(e, src, onLinkClick)}
        >
          {image}
        </a>
      ) : (
        image
      )
    },
    // Contain GFM tables with scrolling so wide content cannot expand narrow sidebar cards.
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
  onLinkClick?: CommentMarkdownLinkClickHandler,
  renderCodeBlock?: DocumentCodeBlockRenderer
): Components {
  return {
    p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
    a: ({ href, children }) =>
      isGitHubUserAttachmentVideoLink(href, children) ? (
        // GitHub APIs return uploaded videos as links; embed them as GitHub’s renderer does.
        <GitHubUserAttachmentVideo href={href}>{children}</GitHubUserAttachmentVideo>
      ) : (
        <a
          href={href || undefined}
          target="_blank"
          rel="noreferrer"
          className="break-all text-primary underline underline-offset-2 hover:text-primary/80"
          onClick={(e) => handleMarkdownAnchorClick(e, href, onLinkClick)}
          onAuxClick={(e) => handleMarkdownAnchorAuxClick(e, href, onLinkClick)}
        >
          {children}
        </a>
      ),
    code: CommentMarkdownDocumentCode,
    pre: ({ node, children }) => (
      <CommentMarkdownDocumentPre
        renderCodeBlock={renderCodeBlock}
        blockLine={node?.position?.start.line}
      >
        {children}
      </CommentMarkdownDocumentPre>
    ),
    ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
    ol: ({ children, start }) => (
      <ol start={start} className="my-2 ml-5 list-decimal space-y-1">
        {children}
      </ol>
    ),
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
    blockquote: ({ node, children }) => {
      const calloutKind = readGitHubCalloutKind(node?.properties.dataCallout)
      return calloutKind ? (
        <MarkdownGitHubCallout kind={calloutKind} className="my-3 border-l-2 pl-3">
          {children}
        </MarkdownGitHubCallout>
      ) : (
        <blockquote className="my-3 border-l-2 border-border/70 pl-3 text-muted-foreground">
          {children}
        </blockquote>
      )
    },
    img: ({ alt, src }) => {
      if (isGitHubUserAttachmentUrl(src)) {
        // Private attachments need GitHub session cookies; top-level links reach authenticated tabs when inline loads fail.
        return <GitHubUserAttachmentImage src={src} alt={alt} />
      }
      if (!src) {
        return alt ? <span>{alt}</span> : null
      }
      // Show document screenshots in a viewport lightbox rather than constraining them to the drawer.
      if (onLinkClick) {
        const imageClassName = [
          'my-3 max-h-96 max-w-full rounded-md object-contain',
          'outline outline-1 outline-black/10 dark:outline-white/10',
          'cursor-pointer'
        ].join(' ')
        return (
          <img
            src={src}
            alt={alt ?? ''}
            className={imageClassName}
            onClick={(e) => handleMarkdownImageClick(e, src, onLinkClick)}
          />
        )
      }
      return (
        <ExpandableMarkdownImage
          src={src}
          alt={alt}
          className="max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-black/10 dark:outline-white/10"
        />
      )
    },
    // Contain document GFM tables even in wider dashboard dialogs.
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

export function selectCommentMarkdownComponents({
  variant,
  onLinkClick,
  renderCodeBlock,
  expandImages
}: {
  variant: 'compact' | 'document'
  onLinkClick?: CommentMarkdownLinkClickHandler
  renderCodeBlock?: DocumentCodeBlockRenderer
  expandImages: boolean
}): Components {
  if (variant === 'document') {
    return onLinkClick || renderCodeBlock
      ? createDocumentCommentMarkdownComponents(onLinkClick, renderCodeBlock)
      : documentCommentMarkdownComponents
  }
  return onLinkClick || expandImages
    ? createCompactCommentMarkdownComponents(onLinkClick, expandImages)
    : compactCommentMarkdownComponents
}
