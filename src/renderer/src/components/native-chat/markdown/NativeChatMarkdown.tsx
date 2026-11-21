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
import { markdownBlockDirection } from '@/components/comment-markdown/markdown-text-direction'
import { cn } from '@/lib/class-names'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../../shared/native-chat/visuals/native-chat-visual-directive'
import { NativeChatMarkdownRowKeyContext } from './native-chat-markdown-row-identity'
import { useNativeChatVisualMarkdownExtension } from '../media/visuals/native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from '../links/actions/use-native-chat-file-link-existence'
import { NativeChatMarkdownImageLinkContext } from '../media/images/NativeChatMarkdownImage'
import { NativeChatDeferredMarkdownImage } from '../media/images/NativeChatDeferredMarkdownImage'
import { remarkNativeChatFileDestinations } from './native-chat-markdown-file-destinations'
import { remarkNativeChatListItemNumbers } from './native-chat-markdown-list-item-numbers'
import { NativeChatLinkPeek } from '../links/previews/NativeChatLinkPeek'
import {
  createNativeChatMentionExtension,
  NativeChatMentionEveryoneContext,
  NativeChatMentionNamesContext,
  NativeChatSlackPeopleContext,
  withBoundBotMentions
} from '../native-chat-markdown-mentions'
import type { SlackPeople } from '../../../../../shared/connectors/slack-message-markup'
import { NativeChatLinkPeekContext } from '../links/previews/native-chat-link-peek-context'
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
  'fileLinkExists' | 'onLinkClick' | 'allowFileUriLinks' | 'singleTildeStrikethrough'
> & {
  /** Underline file paths in the text that exist in the chat's workspace, when the chat can open them. */
  linkifyFilePaths?: boolean
  visualMessageId?: string
  /** The text is still arriving: it renders block by block, so an append re-parses only its tail. */
  streaming?: boolean
  /** The transcript row's identity, so reader choices inside the text outlive the row's mount. */
  rowKey?: string
  /** The content is a Slack message's drawn form: its mention links draw as mentions. */
  slackMentions?: boolean
}

const NO_NAMES: readonly string[] = []

/** Every chat surface rewrites `file:` destinations before sanitize can drop them. */
function withFileDestinations(
  visualExtension: CommentMarkdownExtension | undefined,
  mentionNames: readonly string[] | null,
  everyone = true,
  slackMentions = false,
  slackPeople: SlackPeople | null = null
): CommentMarkdownExtension {
  const names = mentionNames ?? (slackMentions || slackPeople ? NO_NAMES : null)
  const mentions = names
    ? createNativeChatMentionExtension(
        names,
        everyone && names.length > 0,
        slackMentions,
        slackPeople
      )
    : null
  return {
    remarkPlugins: [
      ...(visualExtension?.remarkPlugins ?? []),
      remarkNativeChatFileDestinations,
      ...(mentions?.remarkPlugins ?? [])
    ],
    extraFlowSyntaxMarkers: visualExtension?.remarkPlugins.length
      ? visualExtension.extraFlowSyntaxMarkers
      : [],
    sanitizeAttributes: {
      ...visualExtension?.sanitizeAttributes,
      ...mentions?.sanitizeAttributes
    },
    components: { ...visualExtension?.components, ...mentions?.components }
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

// The chat's own text blocks: list items take the paragraphs' line height (the shared comment
// renderer gives them leading-relaxed), 10px between blocks and 3px between items at 13px.
const NATIVE_CHAT_TEXT_BLOCK_COMPONENTS: CommentMarkdownExtension['components'] = {
  p: ({ node, children }) => (
    <p dir={markdownBlockDirection(node)} className="my-2.5 first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ node, children }) => (
    <ul dir={markdownBlockDirection(node)} className="my-2.5 ms-5 list-disc space-y-0.75">
      {children}
    </ul>
  ),
  ol: ({ node, children, start }) => (
    <ol
      dir={markdownBlockDirection(node)}
      start={start}
      className="my-2.5 ms-5 list-decimal space-y-0.75"
    >
      {children}
    </ol>
  ),
  li: ({ children, value }) => (
    <li value={value} className="[&>input]:pointer-events-none">
      {children}
    </li>
  )
}

function createNativeChatImageExtension(
  visualExtension: CommentMarkdownExtension | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined,
  mentionNames: readonly string[] | null,
  everyone: boolean,
  slackMentions: boolean,
  slackPeople: SlackPeople | null
): CommentMarkdownExtension {
  const Anchor = createDocumentCommentMarkdownComponents(onLinkClick).a
  const base = withFileDestinations(
    visualExtension,
    mentionNames,
    everyone,
    slackMentions,
    slackPeople
  )
  return {
    ...base,
    remarkPlugins: [...base.remarkPlugins, remarkNativeChatListItemNumbers],
    sanitizeAttributes: { ...base.sanitizeAttributes, li: ['value'] },
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
  slackMentions = false,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const onLinkClick = useNativeChatLinkClick()
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const visualExtension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const mentionNames = withBoundBotMentions(useContext(NativeChatMentionNamesContext), content)
  const everyone = useContext(NativeChatMentionEveryoneContext)
  // A Slack message's drawn form has its tokens drawn already.
  const chatSlackPeople = useContext(NativeChatSlackPeopleContext)
  const slackPeople = slackMentions ? null : chatSlackPeople
  const extension = useMemo(
    () =>
      variant === 'document'
        ? createNativeChatImageExtension(
            visualExtension,
            onLinkClick,
            mentionNames,
            everyone,
            slackMentions,
            slackPeople
          )
        : withFileDestinations(visualExtension, mentionNames, everyone, slackMentions, slackPeople),
    [everyone, mentionNames, onLinkClick, slackMentions, slackPeople, variant, visualExtension]
  )
  const fileLinkExists = useNativeChatFileLinkExists(
    linkifyFilePaths && onLinkClick !== undefined,
    streaming
  )
  const { githubRepo } = useContext(NativeChatLinkPeekContext)
  return (
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
        singleTildeStrikethrough={false}
        data-word-fade={wordFadeArmed ? '' : undefined}
        data-block-fade={wordFadeArmed && streaming ? '' : undefined}
        className={cn('native-chat-markdown', className)}
      />
    </NativeChatMarkdownRowKeyContext.Provider>
  )
}
