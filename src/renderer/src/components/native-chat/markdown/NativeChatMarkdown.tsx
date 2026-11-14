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
} from '@/components/sidebar/CommentMarkdown'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/comment-markdown-element-renderers'
import { createDocumentCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'
import { cn } from '@/lib/class-names'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../shared/native-chat/native-chat-visual-directive'
import { NativeChatMarkdownRowKeyContext } from './native-chat-markdown-row-identity'
import { useNativeChatVisualMarkdownExtension } from '../media/visuals/native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from '../links/actions/use-native-chat-file-link-existence'
import {
  NativeChatMarkdownImage,
  NativeChatMarkdownImageLinkContext
} from '../media/images/NativeChatMarkdownImage'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'
import { NativeChatLinkPeek } from '../links/previews/NativeChatLinkPeek'
import { NativeChatLinkPeekContext } from '../links/previews/native-chat-link-peek-context'
import { NativeChatGitHubSeenReposContext } from '../links/previews/native-chat-github-seen-repos'
import { useNativeChatLinkClick } from '../links/actions/native-chat-link-click-context'
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
      img: ({ src, alt }) => <NativeChatMarkdownImage src={src} alt={alt} />,
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
  const githubSeenRepos = useContext(NativeChatGitHubSeenReposContext)
  return (
    <NativeChatMarkdownRowKeyContext.Provider value={rowKey}>
      <CommentMarkdown
        {...props}
        variant={variant}
        growing={growing || streaming}
        // Only the document variant's links can peek; bare #123 links follow it.
        githubRepo={variant === 'document' ? githubRepo?.referenceRepo : undefined}
        githubSeenRepos={variant === 'document' ? githubSeenRepos : undefined}
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
        className={cn('native-chat-markdown', className)}
      />
    </NativeChatMarkdownRowKeyContext.Provider>
  )
}
