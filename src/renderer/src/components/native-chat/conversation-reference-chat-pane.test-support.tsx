import { useRef } from 'react'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'
import { NativeChatComposerField } from './NativeChatComposerField'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useNativeChatDraft } from './use-native-chat-draft'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'

// A test file using this mocks ./NativeChatComposerActions with a Send button that reads
// `sendDisabled`, and ./NativeChatAutocompleteMenus with nothing.

const ignoreSend = (): void => {}

function TestComposer({
  scope,
  disabled,
  environmentId,
  onSend
}: {
  scope: string
  disabled: boolean
  environmentId?: string
  onSend: (scope: string) => void
}): React.JSX.Element {
  const imeEnterGesture = useImeEnterGestureOwnership()
  const textareaRef = useRef<NativeChatComposerInput>(null)
  const { draft, setDraft, flushDraftAppends } = useNativeChatDraft(
    scope,
    imeEnterGesture.isComposing
  )
  return (
    <NativeChatComposerField
      draftScopeKey={scope}
      textareaRef={textareaRef}
      draft={draft}
      disabled={disabled}
      hasPty
      canSend
      autocomplete={{ mode: 'none' }}
      mentionFiles={{ files: [], loading: false, failed: false }}
      activeSuggestion={0}
      notices={[]}
      imageAttachments={[]}
      attachmentEnvironmentId={environmentId}
      sendButtonDisabled={false}
      isWorking={false}
      attachDisabled={false}
      dictationDisabled
      isDictating={false}
      isDictationHoldMode={false}
      imeEnterGesture={imeEnterGesture}
      onDraftChange={(value) => setDraft(value)}
      onTextareaSelect={() => {}}
      onKeyDown={() => {}}
      onImeSettled={(element) => {
        if (element.value !== draft) {
          setDraft(element.value)
        }
        flushDraftAppends()
      }}
      onPaste={() => {}}
      pickerListboxId={`picker-${scope}`}
      onChoosePickerItem={() => {}}
      onRetrySkills={() => {}}
      onChooseMentionFile={() => {}}
      onRemoveImageAttachment={() => {}}
      onAttach={() => {}}
      onDictationToggle={() => {}}
      onDictationHoldStart={() => {}}
      onDictationHoldEnd={() => {}}
      onSend={() => onSend(scope)}
      sessionOptionsSurface={null}
      sessionOptionsSnapshot={[]}
    />
  )
}

type PaneProps = {
  id: string
  scope?: string
  visible: boolean
  focused: boolean
  disabled?: boolean
  environmentId?: string
  onSend?: (scope: string) => void
}

/** A chat root wired the way the chat views wire it, with its composer under a retained host. */
export function ConversationReferenceChatPane({
  id,
  scope = id,
  visible,
  focused,
  disabled = false,
  environmentId,
  onSend = ignoreSend
}: PaneProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  useNativeChatRootInputRouting({
    tabId: id,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible: visible,
    isFocusedGroup: focused,
    composerReady: false
  })
  return (
    <div ref={rootRef} data-testid={`chat-${id}`} data-native-chat-root="true" tabIndex={-1}>
      <div inert={!visible}>
        <TestComposer
          key={scope}
          scope={scope}
          disabled={disabled}
          environmentId={environmentId}
          onSend={onSend}
        />
      </div>
    </div>
  )
}
