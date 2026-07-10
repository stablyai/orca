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
  type CommentMarkdownLinkClickHandler
} from './comment-markdown-element-renderers'

export type { CommentMarkdownLinkClickHandler } from './comment-markdown-element-renderers'

type MarkdownPlugins = NonNullable<React.ComponentProps<typeof Markdown>['rehypePlugins']>
type UrlTransform = NonNullable<React.ComponentProps<typeof Markdown>['urlTransform']>

type GitHubRepoReference = {
  owner: string
  repo: string
}

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

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

function createGitHubIssueUrl(owner: string, repo: string, number: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
}

function isEmbeddedGitHubReference(value: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  return /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

function createGitHubReferenceLinkNode(
  label: string,
  owner: string,
  repo: string,
  number: string
): MarkdownLinkNode {
  return {
    type: 'link',
    url: createGitHubIssueUrl(owner, repo, number),
    title: null,
    children: [{ type: 'text', value: label }]
  }
}

function splitGitHubReferenceText(value: string, defaultRepo: GitHubRepoReference): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) {
      continue
    }

    const owner = match[1] ?? defaultRepo.owner
    const repo = match[2] ?? defaultRepo.repo
    const number = match[3]
    if (!number) {
      continue
    }

    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push(createGitHubReferenceLinkNode(label, owner, repo, number))
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

function transformGitHubReferenceChildren(
  node: MarkdownNode,
  defaultRepo: GitHubRepoReference
): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Why: generated agent comments can contain thousands of issue refs;
      // appending iteratively avoids V8's argument-list limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo)) {
        nextChildren.push(part)
      }
    } else {
      transformGitHubReferenceChildren(child, defaultRepo)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}

export function remarkGitHubReferences(
  defaultRepo: GitHubRepoReference
): () => (tree: MarkdownNode) => void {
  return () => (tree) => transformGitHubReferenceChildren(tree, defaultRepo)
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
  githubRepo?: GitHubRepoReference | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
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
      githubRepo,
      onLinkClick,
      allowFileUriLinks = false,
      ...rest
    },
    ref
  ) {
    const components = React.useMemo(() => {
      if (!onLinkClick) {
        return variant === 'document'
          ? documentCommentMarkdownComponents
          : compactCommentMarkdownComponents
      }
      return variant === 'document'
        ? createDocumentCommentMarkdownComponents(onLinkClick)
        : createCompactCommentMarkdownComponents(onLinkClick)
    }, [variant, onLinkClick])
    const activeRemarkPlugins = React.useMemo(
      () => (githubRepo ? [...remarkPlugins, remarkGitHubReferences(githubRepo)] : remarkPlugins),
      [githubRepo]
    )

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
