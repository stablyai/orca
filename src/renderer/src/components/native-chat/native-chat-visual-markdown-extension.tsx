import { useMemo, useState, type ComponentPropsWithoutRef } from 'react'
import type { ExtraProps } from 'react-markdown'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import {
  NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH,
  isNativeChatVisualFileName
} from '../../../../shared/native-chat-visual-directive'
import { NativeChatInlineVisual } from './NativeChatInlineVisual'
import type { NativeChatVisualOwner } from './native-chat-visual-owner'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import {
  NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES,
  remarkNativeChatVisuals
} from './native-chat-visual-markdown-syntax'

type DivProps = ComponentPropsWithoutRef<'div'> & ExtraProps

/** The placeholder's attributes, as react-markdown passed them (absent on an ordinary div). */
function placeholderAttributes(props: DivProps): { nonce: unknown; file: unknown; title: unknown } {
  return {
    nonce: 'data-orca-visual' in props ? props['data-orca-visual'] : undefined,
    file: 'data-orca-visual-file' in props ? props['data-orca-visual-file'] : undefined,
    title: 'data-orca-visual-title' in props ? props['data-orca-visual-title'] : undefined
  }
}

function newNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function createVisualExtension(
  owner: NativeChatVisualOwner,
  nonce: string
): CommentMarkdownExtension {
  function VisualPlaceholder({ node: _node, ...props }: DivProps): React.JSX.Element {
    const { nonce: placeholderNonce, file, title } = placeholderAttributes(props)
    // Only the parser's own placeholders carry this message's nonce; the fields are re-checked anyway.
    if (
      placeholderNonce !== nonce ||
      typeof file !== 'string' ||
      !isNativeChatVisualFileName(file) ||
      (title !== undefined &&
        (typeof title !== 'string' || title.length > NATIVE_CHAT_VISUAL_TITLE_MAX_LENGTH))
    ) {
      return <div {...props} />
    }
    return (
      <NativeChatInlineVisual
        owner={owner}
        file={file}
        title={typeof title === 'string' && title.length > 0 ? title : null}
      />
    )
  }
  return {
    remarkPlugins: [[remarkNativeChatVisuals, nonce]],
    sanitizeAttributes: { div: [...NATIVE_CHAT_VISUAL_PLACEHOLDER_PROPERTIES] },
    components: { div: VisualPlaceholder }
  }
}

/**
 * The visual extension for one assistant message, or undefined outside a structured chat. Stable
 * for the message's lifetime, so a mounted visual keeps its frame while the reply streams.
 */
export function useNativeChatVisualMarkdownExtension(
  messageId: string | undefined
): CommentMarkdownExtension | undefined {
  const owner = useNativeChatVisualOwner()
  const [nonce] = useState(newNonce)
  return useMemo(
    () => (owner && messageId ? createVisualExtension(owner, nonce) : undefined),
    [messageId, nonce, owner]
  )
}
