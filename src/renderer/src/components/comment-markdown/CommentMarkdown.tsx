import { GitHubBodyImageUrlsContext } from './comment-markdown-github-image-urls'
import type { MarkdownFadeHold } from './comment-markdown-word-fade'
import React from 'react'
import {
  CommentMarkdownMermaidContext,
  CommentMarkdownMermaidSourceContext
} from './comment-markdown-mermaid-policy'
import type { Components, Options as MarkdownOptions } from 'react-markdown'
import {
  commentMarkdownSanitizeSchema,
  commentMarkdownAllowedTagNames,
  commentMarkdownUrlTransform
} from './comment-markdown-sanitize'
import {
  commentMarkdownRemarkPlugins as remarkPlugins,
  doubleTildeStrikethrough
} from './comment-markdown-remark-plugins'
import { remarkChatMath } from './chat-markdown-math'
import { copyChatMathSelection } from './chat-markdown-math-selection'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { type Options as SanitizeSchema } from 'rehype-sanitize'
import remend from 'remend'
import { cn } from '@/lib/class-names'
import {
  selectCommentMarkdownComponents,
  type CommentMarkdownLinkClickHandler,
  type DocumentCodeBlockRenderer
} from './comment-markdown-element-renderers'
import {
  linkNativeChatFilePaths,
  type FileLinkExists
} from '../../../../shared/native-chat/file-access/native-chat-file-link-tree'
import { CommentMarkdownBlockLineContext } from './comment-markdown-code-renderers'
import { MARKDOWN_CLOSING_FENCE, remarkMarkdownClosingFence } from './comment-markdown-code-fence'
import { htmlRendersAsText, remarkUnknownHtmlAsText } from './comment-markdown-unknown-html-as-text'
import { CommentMarkdownWords } from './CommentMarkdownWords'
import {
  MemoizedMarkdown,
  useMarkdownBlocks,
  markdownBlockContent
} from './comment-markdown-block-pipeline'
import {
  linkGitHubReferences,
  type GitHubRepoReference
} from '../../../../shared/github/markdown/github-reference-links'

type MarkdownPlugins = NonNullable<MarkdownOptions['rehypePlugins']>
type RemarkPlugins = NonNullable<MarkdownOptions['remarkPlugins']>
type UrlTransform = NonNullable<MarkdownOptions['urlTransform']>

const commentMarkdownFileUriUrlTransform: UrlTransform = (value, key, node) => {
  if (key === 'href' && node?.tagName === 'a' && value.trim().toLowerCase().startsWith('file:')) {
    return value
  }
  return commentMarkdownUrlTransform(value, key, node)
}

function remarkNativeChatFileLinks(
  exists: FileLinkExists
): () => (tree: Parameters<typeof linkNativeChatFilePaths>[0]) => void {
  return () => (tree) => linkNativeChatFilePaths(tree, exists)
}

export function remarkGitHubReferences(
  defaultRepo: GitHubRepoReference
): () => (tree: Parameters<typeof linkGitHubReferences>[0]) => void {
  return () => (tree) => linkGitHubReferences(tree, defaultRepo)
}

// Escape HTML before remark-breaks so newlines inside it still break.
const unknownHtmlAsTextRemarkPlugins = [
  remarkUnknownHtmlAsText(commentMarkdownAllowedTagNames),
  ...remarkPlugins
]
const unknownHtmlRendersAsText = (html: string): boolean =>
  htmlRendersAsText(html, commentMarkdownAllowedTagNames)

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

function extensionRehypePlugins(
  extension: CommentMarkdownExtension | undefined,
  trackCodeFences: boolean
): MarkdownPlugins {
  const attributes: NonNullable<SanitizeSchema['attributes']> = {
    ...commentMarkdownSanitizeSchema.attributes
  }
  for (const [tagName, names] of Object.entries(extension?.sanitizeAttributes ?? {})) {
    attributes[tagName] = [...(attributes[tagName] ?? []), ...names]
  }
  if (trackCodeFences) {
    attributes.code = [...(attributes.code ?? []), MARKDOWN_CLOSING_FENCE]
  }
  return [rehypeRaw, [rehypeSanitize, { ...commentMarkdownSanitizeSchema, attributes }]]
}

type CommentMarkdownProps = React.ComponentPropsWithoutRef<'div'> & {
  content: string
  bodyImageUrls?: Readonly<Record<string, string>>
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
  /** Content offset where arriving words start; words from it on get their own `data-word`
   *  element, for a stylesheet to fade in. */
  fadeFrom?: number
  /** Selected fading words, whose groups keep their word elements while the window moves past. */
  fadeHold?: MarkdownFadeHold
  extension?: CommentMarkdownExtension
  /** Show raw HTML that sanitize would strip as literal text instead of dropping its tags. */
  unknownHtmlAsText?: boolean
  /** GitHub strikes ~single~ tildes; agent text turns this off so ranges like 1~2 stay literal. */
  singleTildeStrikethrough?: boolean
}

// Why forwardRef + rest props: Radix's HoverCardTrigger asChild merges a ref
// and event handlers (onPointerEnter, onPointerLeave, data-state, etc.) onto
// the child. Without forwarding both, the hover card cannot open or position.
const CommentMarkdown = React.memo(
  React.forwardRef<HTMLDivElement, CommentMarkdownProps>(function CommentMarkdown(
    {
      content,
      bodyImageUrls,
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
      fadeFrom,
      fadeHold,
      extension,
      onCopy,
      unknownHtmlAsText = false,
      singleTildeStrikethrough = true,
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
    const trackCodeFences = renderCodeBlock !== undefined && variant === 'document'
    const activeRehypePlugins = React.useMemo<MarkdownPlugins>(
      () =>
        extension || trackCodeFences
          ? extensionRehypePlugins(extension, trackCodeFences)
          : rehypePlugins,
      [extension, trackCodeFences]
    )
    const activeRemarkPlugins = React.useMemo(() => {
      const htmlPlugins = unknownHtmlAsText ? unknownHtmlAsTextRemarkPlugins : remarkPlugins
      const basePlugins = singleTildeStrikethrough
        ? htmlPlugins
        : [...htmlPlugins, doubleTildeStrikethrough]
      const plugins = fileLinkExists
        ? [...basePlugins, remarkNativeChatFileLinks(fileLinkExists)]
        : basePlugins
      const withMath: RemarkPlugins = math ? [...plugins, remarkChatMath] : plugins
      const withFences = trackCodeFences ? [...withMath, remarkMarkdownClosingFence] : withMath
      const withExtension = extension ? [...withFences, ...extension.remarkPlugins] : withFences
      return githubRepo ? [...withExtension, remarkGitHubReferences(githubRepo)] : withExtension
    }, [
      extension,
      fileLinkExists,
      githubRepo,
      math,
      trackCodeFences,
      singleTildeStrikethrough,
      unknownHtmlAsText
    ])
    const blocks = useMarkdownBlocks(
      content,
      growing,
      math,
      activeRemarkPlugins,
      extension,
      unknownHtmlAsText ? unknownHtmlRendersAsText : undefined
    )
    // Once a reply fades, every block keeps the word renderer (plain where nothing fades), so a
    // block leaving the window keeps its nodes and a reader's selection in it, math included.
    const [hadWordFade, setHadWordFade] = React.useState(fadeFrom !== undefined)
    if (fadeFrom !== undefined && !hadWordFade) {
      setHadWordFade(true)
    }
    const blockComponents = hadWordFade || fadeFrom !== undefined ? fadingComponents : components

    return (
      <GitHubBodyImageUrlsContext.Provider value={bodyImageUrls}>
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
              {blocks.map((block, index) => {
                // Only blocks reaching into the fade window or a held selection fade; earlier ones
                // stay memoized and plain.
                const blockEnd = block.start + block.text.length
                const held =
                  fadeHold !== undefined && fadeHold.from < blockEnd && fadeHold.to > block.start
                // A held block the window has passed keeps one value, so its memo holds.
                const blockFadeFrom =
                  fadeFrom !== undefined && (fadeFrom < blockEnd || held)
                    ? Math.min(block.text.length, Math.max(0, fadeFrom - block.start))
                    : undefined
                const authored = markdownBlockContent(block)
                return (
                  <CommentMarkdownBlockLineContext.Provider key={block.start} value={block.line}>
                    <MemoizedMarkdown
                      block={block.tree ? block : undefined}
                      remarkPlugins={activeRemarkPlugins}
                      rehypePlugins={activeRehypePlugins}
                      math={math}
                      fadeFrom={blockFadeFrom}
                      fadeSettled={!held && index < blocks.length - 1}
                      fadeBase={block.start}
                      authoredCodeFenceSource={trackCodeFences ? block.text : undefined}
                      {...(held
                        ? {
                            fadeHoldFrom: fadeHold.from - block.start,
                            fadeHoldTo: fadeHold.to - block.start
                          }
                        : {})}
                      components={blockComponents}
                      urlTransform={
                        allowFileUriLinks
                          ? commentMarkdownFileUriUrlTransform
                          : commentMarkdownUrlTransform
                      }
                    >
                      {growing && index === blocks.length - 1 && !block.literalMath
                        ? remend(authored, {
                            linkMode: 'text-only',
                            ...(math ? { katex: false, inlineKatex: false } : {})
                          })
                        : authored}
                    </MemoizedMarkdown>
                  </CommentMarkdownBlockLineContext.Provider>
                )
              })}
            </div>
          </CommentMarkdownMermaidSourceContext.Provider>
        </CommentMarkdownMermaidContext.Provider>
      </GitHubBodyImageUrlsContext.Provider>
    )
  })
)

export default CommentMarkdown
