import React from 'react'
import {
  CommentMarkdownMermaidContext,
  CommentMarkdownMermaidSourceContext
} from './comment-markdown-mermaid-policy'
import {
  defaultUrlTransform,
  type Components,
  type Options as MarkdownOptions
} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { remarkChatMath } from './chat-markdown-math'
import { copyChatMathSelection } from './chat-markdown-math-selection'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize'
import remend from 'remend'
import { cn } from '@/lib/utils'
import {
  selectCommentMarkdownComponents,
  isTrustedCompactImageSrc,
  type CommentMarkdownLinkClickHandler,
  type DocumentCodeBlockRenderer
} from './comment-markdown-element-renderers'
import {
  remarkNativeChatFileLinks,
  type FileLinkExists
} from './comment-markdown-native-chat-file-links'
import { CommentMarkdownBlockLineContext } from './comment-markdown-code-renderers'
import { remarkUnknownHtmlAsText } from './comment-markdown-unknown-html-as-text'
import { CommentMarkdownWords } from './CommentMarkdownWords'
import {
  MemoizedMarkdown,
  useMarkdownBlocks,
  markdownBlockContent
} from './comment-markdown-block-pipeline'
import {
  GITHUB_CALLOUT_SANITIZE_ATTRIBUTE,
  remarkGitHubCallouts
} from '@/lib/remark-github-callouts'
import { remarkAutolinkLiteralProseBoundary } from '@/lib/remark-autolink-literal-prose-boundary'

export type { CommentMarkdownLinkClickHandler } from './comment-markdown-element-renderers'

type MarkdownPlugins = NonNullable<MarkdownOptions['rehypePlugins']>
type RemarkPlugins = NonNullable<MarkdownOptions['remarkPlugins']>
type UrlTransform = NonNullable<MarkdownOptions['urlTransform']>

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

// remark-breaks preserves newlines expected by existing plain-text comments; CommonMark otherwise collapses them.
const remarkPlugins = [
  remarkGfm,
  remarkCjkFriendly,
  remarkAutolinkLiteralProseBoundary,
  remarkGitHubCallouts,
  remarkBreaks
]

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
      // Agent replies can contain thousands of issue refs; append iteratively to avoid V8’s argument limit.
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

const commentMarkdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'sub', 'sup', 'ins', 'kbd'],
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), 'href', 'title'],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      GITHUB_CALLOUT_SANITIZE_ATTRIBUTE
    ],
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    img: [...(defaultSchema.attributes?.img ?? []), 'src', 'alt', 'title', 'width', 'height'],
    input: [...(defaultSchema.attributes?.input ?? []), 'type', 'checked', 'disabled'],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'language-math', 'math-inline', 'math-display']
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'language-math', 'math-inline', 'math-display', 'whitespace-pre-wrap']
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'language-math', 'math-inline', 'math-display', 'whitespace-pre-wrap']
    ],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align']
  },
  protocols: {
    ...defaultSchema.protocols,
    // Allow file links through sanitize for native chat; other surfaces still strip them in URL transformation.
    href: [...(defaultSchema.protocols?.href ?? []), 'file'],
    src: [...(defaultSchema.protocols?.src ?? []), 'data', 'blob', 'orca-jira-image']
  }
}

// Escape HTML before remark-breaks so newlines inside it still break.
const unknownHtmlAsTextRemarkPlugins = [
  remarkUnknownHtmlAsText(
    new Set((commentMarkdownSanitizeSchema.tagNames ?? []).map((name) => name.toLowerCase()))
  ),
  ...remarkPlugins
]

// GitHub comments use raw HTML; parse it then sanitize before rendering.
const rehypePlugins: MarkdownPlugins = [rehypeRaw, [rehypeSanitize, commentMarkdownSanitizeSchema]]

/** Keep extensions stable per surface; new objects rebuild components and remount their contents. */
export type CommentMarkdownExtension = {
  remarkPlugins: RemarkPlugins
  /** Extra flow syntax requires one of these markers; omitted means unknown grammar. */
  extraFlowSyntaxMarkers?: readonly string[]
  sanitizeAttributes: Record<string, readonly string[]>
  components: Components
}

function extensionRehypePlugins(extension: CommentMarkdownExtension): MarkdownPlugins {
  const attributes: NonNullable<SanitizeSchema['attributes']> = {
    ...commentMarkdownSanitizeSchema.attributes
  }
  for (const [tagName, names] of Object.entries(extension.sanitizeAttributes)) {
    attributes[tagName] = [...(attributes[tagName] ?? []), ...names]
  }
  return [rehypeRaw, [rehypeSanitize, { ...commentMarkdownSanitizeSchema, attributes }]]
}

type CommentMarkdownProps = React.ComponentPropsWithoutRef<'div'> & {
  content: string
  math?: boolean
  variant?: 'compact' | 'document'
  githubRepo?: GitHubRepoReference | null
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks?: boolean
  /** Turns detected file paths into links, keeping only those this confirms exist. */
  fileLinkExists?: FileLinkExists
  expandImages?: boolean
  renderCodeBlock?: DocumentCodeBlockRenderer
  renderMermaid?: boolean
  keepMermaidSourceWhilePending?: boolean
  /** The content is still being appended to: render it block by block, so each
   *  append re-renders only the last block, and close markup its end leaves open.
   *  The block-by-block render stays on once seen. */
  growing?: boolean
  /** Give each word its own `data-word` element, for a stylesheet to animate as words arrive. */
  fadeWords?: boolean
  extension?: CommentMarkdownExtension
  /** Show raw HTML that sanitize would strip as literal text instead of dropping its tags. */
  unknownHtmlAsText?: boolean
}

// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdown = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdown(
    {
      content,
      math = false,
      className,
      variant = 'compact',
      githubRepo,
      onLinkClick,
      allowFileUriLinks = false,
      fileLinkExists,
      expandImages = false,
      renderCodeBlock,
      renderMermaid = true,
      keepMermaidSourceWhilePending = false,
      growing = false,
      fadeWords = false,
      extension,
      onCopy,
      unknownHtmlAsText = false,
      ...rest
    },
    ref
  ) {
    const baseComponents = React.useMemo(
      () =>
        selectCommentMarkdownComponents({
          variant,
          onLinkClick,
          renderCodeBlock,
          expandImages
        }),
      [expandImages, renderCodeBlock, variant, onLinkClick]
    )
    const components = React.useMemo(
      () => (extension ? { ...baseComponents, ...extension.components } : baseComponents),
      [baseComponents, extension]
    )
    const fadingComponents = React.useMemo(
      () => ({ ...components, span: CommentMarkdownWords }),
      [components]
    )
    const activeRehypePlugins = React.useMemo<MarkdownPlugins>(
      () => (extension ? extensionRehypePlugins(extension) : rehypePlugins),
      [extension]
    )
    const activeRemarkPlugins = React.useMemo(() => {
      const basePlugins = unknownHtmlAsText ? unknownHtmlAsTextRemarkPlugins : remarkPlugins
      const plugins = fileLinkExists
        ? [...basePlugins, remarkNativeChatFileLinks(fileLinkExists)]
        : basePlugins
      const withMath: RemarkPlugins = math ? [...plugins, remarkChatMath] : plugins
      const withExtension = extension ? [...withMath, ...extension.remarkPlugins] : withMath
      return githubRepo ? [...withExtension, remarkGitHubReferences(githubRepo)] : withExtension
    }, [extension, fileLinkExists, githubRepo, math, unknownHtmlAsText])
    const blocks = useMarkdownBlocks(content, growing, math, activeRemarkPlugins, extension)
    const [hadWordFade, setHadWordFade] = React.useState(fadeWords)
    if (fadeWords && !hadWordFade) {
      setHadWordFade(true)
    }
    const wrapsWords = fadeWords || hadWordFade

    return (
      <CommentMarkdownMermaidContext.Provider value={renderMermaid}>
        <CommentMarkdownMermaidSourceContext.Provider value={keepMermaidSourceWhilePending}>
          <div
            ref={ref}
            className={cn(
              // Descendant pre/code selectors outrank inline-code pill utilities to reset block-code styling.
              '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none',
              'min-w-0 max-w-full [overflow-wrap:anywhere]',
              className
            )}
            onCopy={(event) => {
              onCopy?.(event)
              if (math && !event.defaultPrevented) {
                copyChatMathSelection(event)
              }
            }}
            {...rest}
          >
            {blocks.map((block, index) => (
              <CommentMarkdownBlockLineContext.Provider key={block.start} value={block.line}>
                <MemoizedMarkdown
                  block={block.tree ? block : undefined}
                  remarkPlugins={activeRemarkPlugins}
                  rehypePlugins={activeRehypePlugins}
                  math={math}
                  fadeWords={wrapsWords}
                  components={wrapsWords ? fadingComponents : components}
                  urlTransform={
                    allowFileUriLinks
                      ? commentMarkdownFileUriUrlTransform
                      : commentMarkdownUrlTransform
                  }
                >
                  {growing && index === blocks.length - 1 && !block.literalMath
                    ? remend(markdownBlockContent(block), {
                        linkMode: 'text-only',
                        ...(math ? { katex: false, inlineKatex: false } : {})
                      })
                    : markdownBlockContent(block)}
                </MemoizedMarkdown>
              </CommentMarkdownBlockLineContext.Provider>
            ))}
          </div>
        </CommentMarkdownMermaidSourceContext.Provider>
      </CommentMarkdownMermaidContext.Provider>
    )
  })
)

export default CommentMarkdown
