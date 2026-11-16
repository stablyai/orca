import type { MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { Editor } from '@tiptap/react'
import type { LinkBubbleState } from '../links/RichMarkdownLinkBubble'
import type { DocLinkMenuRow, DocLinkMenuState } from '../doc-links/rich-markdown-commands'
import type { SlashCommand, SlashMenuState } from './rich-markdown-slash-command-primitives'
import type { RichMarkdownHtmlSuperscriptLinkContext } from '../citations/rich-markdown-html-superscript-link-context'

export type KeyHandlerContext = {
  isMac: boolean
  editorRef: MutableRefObject<Editor | null>
  rootRef: MutableRefObject<HTMLDivElement | null>
  lastCommittedMarkdownRef: MutableRefObject<string>
  originalSourceRef: MutableRefObject<string>
  baseCanonicalRef: MutableRefObject<string>
  reconcileRoundTripRef: MutableRefObject<(markdown: string) => string | null>
  onContentChangeRef: MutableRefObject<(content: string) => void>
  onSaveRef: MutableRefObject<(content: string) => void>
  isEditingLinkRef: MutableRefObject<boolean>
  slashMenuRef: MutableRefObject<SlashMenuState | null>
  filteredSlashCommandsRef: MutableRefObject<SlashCommand[]>
  selectedCommandIndexRef: MutableRefObject<number>
  docLinkMenuRef: MutableRefObject<DocLinkMenuState | null>
  filteredDocLinkRowsRef: MutableRefObject<DocLinkMenuRow[]>
  selectedDocLinkIndexRef: MutableRefObject<number>
  handleLocalImagePickRef: MutableRefObject<() => void>
  handleEmojiPickRef: MutableRefObject<(menu: SlashMenuState) => void>
  typedEmptyOrderedListMarkerRef: MutableRefObject<boolean>
  /** Returns true when the pending edit was rejected instead of committed. */
  flushPendingSerialization: () => boolean
  openSearchRef: MutableRefObject<() => void>
  openAnnotationPopoverRef: MutableRefObject<(requireLiveSelection?: boolean) => boolean>
  setIsEditingLink: (editing: boolean) => void
  setLinkBubble: (bubble: LinkBubbleState | null) => void
  setSelectedCommandIndex: Dispatch<SetStateAction<number>>
  setSelectedDocLinkIndex: Dispatch<SetStateAction<number>>
  setSlashMenu: Dispatch<SetStateAction<SlashMenuState | null>>
  setDocLinkMenu: (menu: DocLinkMenuState | null) => void
  openSelectedHtmlSuperscriptLink?: () => boolean
  linkBubbleOwnerId: string
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext
}
