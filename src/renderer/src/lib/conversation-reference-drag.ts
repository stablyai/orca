import {
  ConversationReferenceCreateParams,
  CONVERSATION_REFERENCE_DRAG_TYPE,
  type ConversationReferenceCreate
} from '../../../shared/conversation-reference'

export function writeConversationReferenceDrag(
  data: DataTransfer,
  source: ConversationReferenceCreate
): void {
  data.effectAllowed = 'copy'
  data.setData(CONVERSATION_REFERENCE_DRAG_TYPE, JSON.stringify(source))
}

export function readConversationReferenceDrag(
  data: DataTransfer
): ConversationReferenceCreate | null {
  const raw = data.getData(CONVERSATION_REFERENCE_DRAG_TYPE)
  if (!raw || raw.length > 64 * 1024) {
    return null
  }
  try {
    const parsed = ConversationReferenceCreateParams.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
