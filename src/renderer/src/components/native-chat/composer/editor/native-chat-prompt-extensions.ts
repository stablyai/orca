import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import type { Extensions } from '@tiptap/react'
import { translate } from '@/i18n/i18n'
import { NativeChatAgentReference } from './native-chat-agent-reference'
import {
  NativeChatFileReference,
  NativeChatImageReference,
  NativeChatSkill
} from './native-chat-prompt-document'
import { NativeChatSideChat } from './native-chat-side-chat-node'
import { NativeChatUnkernedRunDecorations } from './native-chat-unkerned-run-decorations'

/** The composer's plain-text schema: paragraphs, hard breaks and the pills only Orca inserts. */
export function nativeChatPromptExtensions(live: {
  placeholder: () => string
  sideChat: () => boolean
}): Extensions {
  return [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      orderedList: false,
      strike: false,
      underline: false,
      trailingNode: false
    }),
    NativeChatAgentReference,
    NativeChatSkill,
    NativeChatFileReference,
    NativeChatImageReference,
    NativeChatSideChat.configure({
      enabled: live.sideChat,
      placeholder: () =>
        translate('components.native-chat.sideChat.placeholder', 'Ask a side question')
    }),
    NativeChatUnkernedRunDecorations,
    // A disabled box still says why it is disabled, as the plain text box's placeholder does.
    Placeholder.configure({ placeholder: live.placeholder, showOnlyWhenEditable: false })
  ]
}
