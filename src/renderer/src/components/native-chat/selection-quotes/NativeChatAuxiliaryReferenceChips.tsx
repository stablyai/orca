import {
  nativeChatAuxiliaryReferenceKey,
  removeNativeChatAuxiliaryReference,
  useNativeChatAuxiliaryReferences
} from './native-chat-auxiliary-references'
import { NativeChatAuxiliaryReferenceChip } from './NativeChatAuxiliaryReferenceChip'
import type { NativeChatSentPromptReference } from '../../../../../shared/native-chat/transcript/messages/native-chat-sent-prompt-references'

/** Unsent selections for the next message: frozen words, removable, never part of the draft. */
export function NativeChatAuxiliaryReferenceChips({
  scopeKey
}: {
  scopeKey: string
}): React.JSX.Element | null {
  const references = useNativeChatAuxiliaryReferences(scopeKey)
  if (references.length === 0) {
    return null
  }
  return (
    <div
      className="mb-2 flex max-w-full flex-wrap gap-2 px-1 pt-1.5"
      data-native-chat-auxiliary-reference-count={references.length}
    >
      {references.map((reference) => (
        <NativeChatAuxiliaryReferenceChip
          key={nativeChatAuxiliaryReferenceKey(reference)}
          text={reference.text}
          onRemove={() => removeNativeChatAuxiliaryReference(scopeKey, reference)}
        />
      ))}
    </div>
  )
}

/** The selections a sent user message carried, read either from the current or legacy block. */
export function NativeChatSentReferenceChips({
  references
}: {
  references: readonly NativeChatSentPromptReference[]
}): React.JSX.Element | null {
  if (references.length === 0) {
    return null
  }
  return (
    <div
      className="mb-2 flex max-w-full flex-wrap gap-2"
      data-native-chat-sent-reference-count={references.length}
    >
      {references.map((reference, index) => (
        <NativeChatAuxiliaryReferenceChip key={index} text={reference.text} />
      ))}
    </div>
  )
}
