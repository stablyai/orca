import type { NativeChatComposerInput } from './composer/editor/native-chat-composer-input'
import type { useImeEnterGestureOwnership } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/composer/native-chat-picker-items'
import type { NativeChatMentionFiles } from './composer/pickers/use-native-chat-mention-files'
import type { NativeChatComposerNotice } from './composer/controls/native-chat-composer-notice'
import type { NativeChatContextUsageSummary } from '../../../../shared/native-chat/native-chat-context-usage-summary'
import type { NativeChatAfterStopSend } from './composer/submit/native-chat-composer-target'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatComposerGoalMode } from './composer/submit/use-native-chat-composer-submit'
import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { NativeChatSteerChordPreview } from '../../../../shared/native-chat/input/composer/use-native-chat-steer-chord-preview'
import type { NativeChatComposerImageAttachment } from './attachments/chips/native-chat-image-attachment'
import type { NativeChatOptionPickerRequest } from './session/options/controls/native-chat-option-picker-request'

export type NativeChatComposerFieldProps = {
  dock?: React.ReactNode
  editSession?: { cancel: () => void }
  /** Own draft persistence and native-drop routing by this pane so drops cannot land in another composer. */
  draftScopeKey: string
  positionTarget?: string
  textareaRef: React.RefObject<NativeChatComposerInput | null>
  draft: string
  disabled: boolean
  hasPty: boolean
  canSend: boolean
  /** Replaces the default placeholder and any suggestion: why input is unavailable. */
  placeholderHint?: string | undefined
  /** A room's hint, shown only while there is no prompt suggestion to show (and take with Tab). */
  idleHint?: string | undefined
  /** The agent's suggested next prompt, shown in the placeholder's place; Tab takes it. */
  promptSuggestion?: string | undefined
  autocomplete: ComposerAutocomplete
  mentionFiles: NativeChatMentionFiles
  activeSuggestion: number
  notices: readonly NativeChatComposerNotice[]
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  /** Ordered image labels match the provider attachment order. */
  numberImages?: boolean
  /** The paired server a structured chat runs on, which reads back files stored there. */
  attachmentEnvironmentId?: string
  sendButtonDisabled: boolean
  /** Why the send button is disabled, when the user can do something about it. */
  sendBlockedReason?: string | null
  isWorking: boolean
  /** The draft holds text or images, so Send takes Stop's place while the agent works. */
  hasDraft?: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend?: NativeChatFollowUpBehavior
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** After Stop, describe whether the host queues the next message as a card or holds the send. */
  afterStop?: NativeChatAfterStopSend
  attachDisabled: boolean
  dictationDisabled: boolean
  isDictating: boolean
  isDictationHoldMode: boolean
  imeEnterGesture: ReturnType<typeof useImeEnterGestureOwnership>
  onDraftChange: (value: string, element: NativeChatComposerInput) => void
  onTextareaSelect: (element: NativeChatComposerInput) => void
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
  onImeSettled: (element: NativeChatComposerInput) => void
  onPaste: React.ClipboardEventHandler<HTMLElement>
  pickerListboxId: string
  onChoosePickerItem: (item: NativeChatPickerItem) => void
  onRetrySkills: () => void
  onChooseMentionFile: (path: string) => void
  /** The pointer moved onto an `@` row, which takes the one highlight. */
  onHoverMentionOption?: (index: number) => void
  onRemoveImageAttachment: (id: string) => void
  onAttach: () => void
  onDictationToggle: () => void
  onDictationHoldStart: () => void
  onDictationHoldEnd: () => void
  onSend: () => void
  /** Held Cmd/Ctrl: Send shows, and a click runs, what Cmd/Ctrl+Enter would do. */
  steerPreview?: NativeChatSteerChordPreview | null
  onSteerPreview?: () => void
  onStop?: () => void
  sessionOptionsSurface: SessionOptionsSurface | null
  sessionOptionsSnapshot: SessionOptionDescriptor[]
  contextUsage?: NativeChatContextUsageSummary | null
  sessionOptionsPickerRequest?: NativeChatOptionPickerRequest | null
  goalMode?: NativeChatComposerGoalMode
  agent?: string
  launchPrompt?: { placeholder: string }
  workspaceFooter?: React.ReactNode
}
