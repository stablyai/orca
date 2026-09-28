import React from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { cn } from '@/lib/utils'
import {
  compactCommentMarkdownComponents,
  createCompactCommentMarkdownComponents,
  createDocumentCommentMarkdownComponents,
  documentCommentMarkdownComponents,
  isTrustedCompactImageSrc,
  type CommentMarkdownLinkClickHandler,
  type DocumentCodeBlockRenderer
} from './comment-markdown-element-renderers'
import { remarkNativeChatFileLinks } from './comment-markdown-native-chat-file-links'
import { buildGitHubRepoUrl } from '../../../../shared/github/links'
import type { IssueReferenceTarget } from '../../../../shared/linked-issue-provider'
import { buildGitLabIssueUrl } from '../../../../shared/new-workspace/gitlab-links'

export type { IssueReferenceTarget }

export type { CommentMarkdownLinkClickHandler } from './comment-markdown-element-renderers'

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>
type UrlTransform = NonNullable<React.ComponentProps<typeof Markdown>['urlTransform']>

type MarkdownTextNode = {
  type: 'text'
  value: string
}

type MarkdownLinkNode = {
  type: 'link'
  url: string
  title: null
  children: MarkdownTextNode[]
}

type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
}

const commentMarkdownUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'src' && node?.tagName === 'img' && isTrustedCompactImageSrc(value)) {
    return value
  }
  return defaultUrlTransform(value)
}

const commentMarkdownFileUriUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'href' && node?.tagName === 'a' && value.trim().toLowerCase().startsWith('file:')) {
    return value
  }
  return commentMarkdownUrlTransform(value, key, node)
}

// Why: standard CommonMark collapses single newlines into spaces. The old
// plain-text renderer used whitespace-pre-wrap which preserved them. Adding
// remark-breaks converts single newlines to <br>, keeping backward compat
// with existing plain-text comments that rely on newline formatting.
const remarkPlugins = [remarkGfm, remarkBreaks]

const ISSUE_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

function createIssueReferenceUrl(
  target: IssueReferenceTarget,
  explicitSlug: { owner: string; repo: string } | null,
  number: string
): string | null {
  if (target.provider === 'gitlab') {
    // Why: GitLab group paths nest arbitrarily deep, so the two-segment
    // `owner/repo#N` capture would build a confidently wrong URL. Bare #N only.
    return explicitSlug ? null : buildGitLabIssueUrl(target.slug, Number(number))
  }
  // An explicit owner/repo#N in a GHES comment means a repo on that GHES server,
  // so it inherits the default repo's host rather than falling back to github.com.
  const base = buildGitHubRepoUrl(
    explicitSlug ? { ...explicitSlug, host: target.slug.host } : target.slug
  )
  return base === null ? null : `${base}/issues/${number}`
}

function isEmbeddedIssueReference(value: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  return /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

function createIssueReferenceLinkNode(label: string, url: string): MarkdownLinkNode {
  return {
    type: 'link',
    url,
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

function splitIssueReferenceText(value: string, target: IssueReferenceTarget): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(ISSUE_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedIssueReference(value, index)) {
      continue
    }

    const number = match[3]
    if (!number) {
      continue
    }
    const owner = match[1]
    const repo = match[2]
    const url = createIssueReferenceUrl(target, owner && repo ? { owner, repo } : null, number)
    if (url === null) {
      continue
    }

    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push(createIssueReferenceLinkNode(label, url))
    cursor = index + label.length
  }

  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

function transformIssueReferenceChildren(node: MarkdownNode, target: IssueReferenceTarget): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Why: generated agent comments can contain thousands of issue refs;
      // appending iteratively avoids V8's argument-list limit.
      for (const part of splitIssueReferenceText(child.value, target)) {
        nextChildren.push(part)
      }
    } else {
      transformIssueReferenceChildren(child, target)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}

export function remarkIssueReferences(
  target: IssueReferenceTarget
): () => (tree: MarkdownNode) => void {
  return () => (tree) => transformIssueReferenceChildren(tree, target)
}

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
  },
  protocols: {
    ...defaultSchema.protocols,
    // Why: native chat opts into file URI links after sanitize; the URL
    // transform below still strips them for all other markdown surfaces.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'blob']
  }
}

// Why: GitHub comments often include safe raw HTML (`<sub>`, `<details>`,
// `<br />`). Parse it, then sanitize immediately before React renders it.
const rehypePlugins: MarkdownPlugins = [rehypeRaw, [rehypeSanitize, commentMarkdownSanitizeSchema]]

type CommentMarkdownProps = React.ComponentPropsWithoutRef<'div'> & {
  content: string
  variant?: 'compact' | 'document'
  issueReferences?: IssueReferenceTarget | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  linkifyFilePaths?: boolean
  expandImages?: boolean
  renderCodeBlock?: DocumentCodeBlockRenderer
}

// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdown = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdown(
    {
      content,
      className,
      variant = 'compact',
      issueReferences,
      onLinkClick,
      allowFileUriLinks = false,
      linkifyFilePaths = false,
      expandImages = false,
      renderCodeBlock,
      ...rest
    },
    ref
  ) {
    const components = React.useMemo(() => {
      if (!onLinkClick) {
        return variant === 'document'
          ? renderCodeBlock
            ? createDocumentCommentMarkdownComponents(undefined, renderCodeBlock)
            : documentCommentMarkdownComponents
          : expandImages
            ? createCompactCommentMarkdownComponents(undefined, true)
            : compactCommentMarkdownComponents
      }
      return variant === 'document'
        ? createDocumentCommentMarkdownComponents(onLinkClick, renderCodeBlock)
        : createCompactCommentMarkdownComponents(onLinkClick, expandImages)
    }, [expandImages, renderCodeBlock, variant, onLinkClick])
    const activeRemarkPlugins = React.useMemo(() => {
      const plugins = linkifyFilePaths
        ? [...remarkPlugins, remarkNativeChatFileLinks]
        : remarkPlugins
      return issueReferences ? [...plugins, remarkIssueReferences(issueReferences)] : plugins
    }, [issueReferences, linkifyFilePaths])

    return (
      <div
        ref={ref}
        className={cn(
          // Reset inline-code pill styles when <code> is inside a <pre> block.
          // The descendant selector (pre code) has higher specificity than the
          // direct utility classes on <code>, so these overrides win reliably.
          '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none',
          'min-w-0 max-w-full [overflow-wrap:anywhere]',
          className
        )}
        {...rest}
      >
        <Markdown
          remarkPlugins={activeRemarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
          urlTransform={
            allowFileUriLinks ? commentMarkdownFileUriUrlTransform : commentMarkdownUrlTransform
          }
        >
          {content}
        </Markdown>
      </div>
    )
  })
)

export default CommentMarkdown
