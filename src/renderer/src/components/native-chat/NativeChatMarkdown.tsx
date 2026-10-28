import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode
} from 'react'
import CommentMarkdown, {
  type CommentMarkdownExtension,
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { createDocumentCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat/native-chat-visual-directive'
import { NativeChatMarkdownRowKeyContext } from './native-chat-disclosure-store'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from './use-native-chat-file-link-existence'
import {
  NativeChatMarkdownImage,
  NativeChatMarkdownImageLinkContext
} from './NativeChatMarkdownImage'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'
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

type NativeChatMarkdownProps = Omit<ComponentProps<typeof CommentMarkdown>, 'fileLinkExists'> & {
  /** Underline file paths in the text that exist in the chat's workspace. */
  linkifyFilePaths?: boolean
  visualMessageId?: string
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

function createNativeChatImageExtension(
  visualExtension: CommentMarkdownExtension | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): CommentMarkdownExtension {
  const Anchor = createDocumentCommentMarkdownComponents(onLinkClick).a
  const base = withFileDestinations(visualExtension)
  return {
    ...base,
    components: {
      ...base.components,
      img: ({ src, alt }) => (
        <NativeChatMarkdownImage src={src} alt={alt} onLinkClick={onLinkClick} />
      ),
      a: (props) => {
        const renderAnchor = (children: ReactNode): ReactNode =>
          typeof Anchor === 'function' ? (
            <Anchor {...props}>{children}</Anchor>
          ) : (
            <a href={props.href}>{children}</a>
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
  rowKey,
  content,
  variant,
  onLinkClick,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const visualExtension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const extension = useMemo(
    () =>
      variant === 'document'
        ? createNativeChatImageExtension(visualExtension, onLinkClick)
        : withFileDestinations(visualExtension),
    [onLinkClick, variant, visualExtension]
  )
  const fileLinkExists = useNativeChatFileLinkExists(linkifyFilePaths, streaming)
  return (
    <NativeChatMarkdownRowKeyContext.Provider value={rowKey}>
      <CommentMarkdown
        {...props}
        variant={variant}
        onLinkClick={onLinkClick}
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
        className={cn('native-chat-markdown', className)}
      />
    </NativeChatMarkdownRowKeyContext.Provider>
  )
}
