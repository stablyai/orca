import {
  Children,
  cloneElement,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import CommentMarkdown, {
  type CommentMarkdownExtension
} from '@/components/comment-markdown/CommentMarkdown'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { createDocumentCommentMarkdownComponents } from '@/components/comment-markdown/comment-markdown-element-renderers'
import { cn } from '@/lib/class-names'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../shared/native-chat/visuals/native-chat-visual-directive'
import { NativeChatMarkdownRowKeyContext } from './native-chat-markdown-row-identity'
import { useNativeChatVisualMarkdownExtension } from '../media/visuals/native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from '../links/actions/use-native-chat-file-link-existence'
import { NativeChatMarkdownImageLinkContext } from '../media/images/NativeChatMarkdownImage'
import { NativeChatDeferredMarkdownImage } from '../media/images/NativeChatDeferredMarkdownImage'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'
import { NativeChatLinkPeek } from '../links/previews/NativeChatLinkPeek'
import { NativeChatLinkPeekContext } from '../links/previews/native-chat-link-peek-context'
import { useNativeChatLinkClick } from '../links/actions/native-chat-link-click-context'
import type { Element as HastElement } from 'hast'
import {
  blockTextDirection,
  hasRightToLeftText,
  markdownProseText,
  NativeChatTextDirectionContext,
  textDirectionOf,
  type NativeChatTextDirection
} from './native-chat-text-direction'
import './native-chat-markdown.css'

/** Existing words stay opaque when a reply first starts growing. */
function useWordFadeArmed(fadeWords: boolean): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!fadeWords) {
      setArmed(false)
      return
    }
    const frame = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(frame)
  }, [fadeWords])
  return armed && fadeWords
}

type NativeChatMarkdownProps = Omit<
  ComponentProps<typeof CommentMarkdown>,
  'fileLinkExists' | 'onLinkClick' | 'allowFileUriLinks'
> & {
  /** Underline file paths in the text that exist in the chat's workspace, when the chat can open them. */
  linkifyFilePaths?: boolean
  visualMessageId?: string
  /** The text is still arriving: it renders block by block, so an append re-parses only its tail. */
  streaming?: boolean
  /** The transcript row's identity, so reader choices inside the text outlive the row's mount. */
  rowKey?: string
}

/** Every chat surface rewrites `file:` destinations before sanitize can drop them. */
function withFileDestinations(
  visualExtension: CommentMarkdownExtension | undefined
): CommentMarkdownExtension {
  return {
    remarkPlugins: [...(visualExtension?.remarkPlugins ?? []), remarkNativeChatFileDestinations],
    extraFlowSyntaxMarkers: visualExtension?.remarkPlugins.length
      ? visualExtension.extraFlowSyntaxMarkers
      : [],
    sanitizeAttributes: visualExtension?.sanitizeAttributes ?? {},
    components: visualExtension?.components ?? {}
  }
}

type MarkdownElementProps = { node?: { tagName: string }; children?: ReactNode }

function containsImage(children: ReactNode): boolean {
  return Children.toArray(children).some(
    (child) =>
      isValidElement<MarkdownElementProps>(child) &&
      (child.props.node?.tagName === 'img' || containsImage(child.props.children))
  )
}

type TextBlockProps = { node?: HastElement; children?: ReactNode }

function useBlockDirection(node: HastElement | undefined): NativeChatTextDirection | undefined {
  return blockTextDirection(node, useContext(NativeChatTextDirectionContext))
}

function NativeChatParagraph({ node, children }: TextBlockProps): React.JSX.Element {
  return (
    <p dir={useBlockDirection(node)} className="my-2.5 first:mt-0 last:mb-0">
      {children}
    </p>
  )
}

function NativeChatBulletList({ node, children }: TextBlockProps): React.JSX.Element {
  return (
    <ul dir={useBlockDirection(node)} className="my-2.5 ms-5 list-disc space-y-0.75">
      {children}
    </ul>
  )
}

function NativeChatNumberedList({
  node,
  children,
  start
}: TextBlockProps & { start?: number }): React.JSX.Element {
  return (
    <ol
      start={start}
      dir={useBlockDirection(node)}
      className="my-2.5 ms-5 list-decimal space-y-0.75"
    >
      {children}
    </ol>
  )
}

// The chat's own text blocks: list items take the paragraphs' line height (the shared comment
// renderer gives them leading-relaxed), 10px between blocks and 3px between items at 13px.
const NATIVE_CHAT_TEXT_BLOCK_COMPONENTS: CommentMarkdownExtension['components'] = {
  p: NativeChatParagraph,
  ul: NativeChatBulletList,
  ol: NativeChatNumberedList,
  li: ({ children }) => <li className="[&>input]:pointer-events-none">{children}</li>
}

function createNativeChatImageExtension(
  visualExtension: CommentMarkdownExtension | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): CommentMarkdownExtension {
  const Anchor = createDocumentCommentMarkdownComponents(onLinkClick).a
  const base = withFileDestinations(visualExtension)
  return {
    ...base,
    components: {
      ...NATIVE_CHAT_TEXT_BLOCK_COMPONENTS,
      ...base.components,
      img: ({ src, alt }) => <NativeChatDeferredMarkdownImage src={src} alt={alt} />,
      a: (props) => {
        const renderAnchor = (children: ReactNode): ReactNode => (
          <NativeChatLinkPeek href={props.href}>
            {typeof Anchor === 'function' ? (
              <Anchor {...props}>{children}</Anchor>
            ) : (
              <a href={props.href}>{children}</a>
            )}
          </NativeChatLinkPeek>
        )
        const renderChild = (child: ReactNode): ReactNode => {
          if (!isValidElement<MarkdownElementProps>(child) || !containsImage(child)) {
            return renderAnchor(child)
          }
          if (child.props.node?.tagName === 'img') {
            return (
              <NativeChatMarkdownImageLinkContext.Provider value={props.href}>
                <span data-native-chat-link-href={props.href}>{child}</span>
              </NativeChatMarkdownImageLinkContext.Provider>
            )
          }
          return cloneElement(child, {}, Children.map(child.props.children, renderChild))
        }
        return containsImage(props.children)
          ? Children.map(props.children, renderChild)
          : renderAnchor(props.children)
      }
    }
  }
}

export function NativeChatMarkdown({
  className,
  linkifyFilePaths = false,
  fadeWords = false,
  visualMessageId,
  streaming = false,
  growing = false,
  rowKey,
  content,
  variant,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const visualExtension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const extension = useMemo(
    () =>
      variant === 'document'
        ? createNativeChatImageExtension(visualExtension, onLinkClick)
        : withFileDestinations(visualExtension),
    [onLinkClick, variant, visualExtension]
  )
  const fileLinkExists = useNativeChatFileLinkExists(
    linkifyFilePaths && onLinkClick !== undefined,
    streaming
  )
  const { githubRepo } = useContext(NativeChatLinkPeekContext)
  const prose = markdownProseText(content)
  const bidi = hasRightToLeftText(prose)
  const messageDirection: NativeChatTextDirection | undefined =
    bidi && textDirectionOf(prose) === 'rtl' ? 'rtl' : undefined
  // Keyed on the outcome, not the text, so streamed tokens don't re-render every memoized block.
  const textDirection = useMemo(
    () => ({ message: messageDirection, bidi }),
    [messageDirection, bidi]
  )
  return (
    <NativeChatTextDirectionContext.Provider value={textDirection}>
      <NativeChatMarkdownRowKeyContext.Provider value={rowKey}>
        <CommentMarkdown
          {...props}
          variant={variant}
          growing={growing || streaming}
          // Only the document variant's links can peek; bare #123 links follow it.
          githubRepo={variant === 'document' ? githubRepo?.referenceRepo : undefined}
          onLinkClick={onLinkClick}
          allowFileUriLinks={onLinkClick !== undefined}
          content={
            visualExtension && streaming
              ? withoutPendingNativeChatVisualDirectiveTail(content)
              : content
          }
          math
          extension={extension}
          fileLinkExists={fileLinkExists}
          fadeWords={fadeWords}
          renderMermaid={!streaming}
          keepMermaidSourceWhilePending
          unknownHtmlAsText
          data-word-fade={wordFadeArmed ? '' : undefined}
          data-block-fade={wordFadeArmed && streaming ? '' : undefined}
          dir={textDirection.message}
          data-native-chat-bidi={textDirection.bidi ? '' : undefined}
          className={cn('native-chat-markdown', className)}
        />
      </NativeChatMarkdownRowKeyContext.Provider>
    </NativeChatTextDirectionContext.Provider>
  )
}
