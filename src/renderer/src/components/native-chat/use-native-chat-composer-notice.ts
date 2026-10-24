import {
  createNativeChatReturnField,
  useNativeChatReturnState
} from './native-chat-view-state-memory'
import { useCallback, useMemo } from 'react'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'
import type {
  NativeChatComposerErrorDetail,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { StructuredConversationCommandCauses } from './structured-conversation-command-send'

type ComposerErrorLine = NativeChatComposerNoticeContent &
  Pick<NativeChatComposerErrorDetail, 'refusedWhile'>

const attachmentNotice = createNativeChatReturnField<NativeChatComposerNoticeContent | null>()
const errorLine = createNativeChatReturnField<ComposerErrorLine | null>()

/** The composer's own paste and attachment notice, after the chat's notices and the input hold. */
export function useNativeChatComposerNotice(
  chatNotices?: readonly NativeChatComposerNotice[],
  holdNotice?: NativeChatComposerNotice | null
): {
  notices: readonly NativeChatComposerNotice[]
  setNotice: (text: string | null, errorText?: string) => void
} {
  const [notice, setNoticeContent] = useNativeChatReturnState(attachmentNotice, () => null)
  const setNotice = useCallback(
    (text: string | null, errorText?: string) =>
      setNoticeContent(text === null ? null : { text, ...(errorText ? { errorText } : {}) }),
    []
  )
  const notices = useMemo(
    () => [
      ...(chatNotices ?? []),
      ...(holdNotice ? [holdNotice] : []),
      ...(notice
        ? [
            {
              key: 'composer-attachment',
              kind: 'attachment' as const,
              ...notice,
              onDismiss: () => setNotice(null)
            }
          ]
        : [])
    ],
    [chatNotices, holdNotice, notice, setNotice]
  )
  return { notices, setNotice }
}

/** A chat's last send or command error: shown in the card until dismissed or the next send clears
 *  it. A command's refusal names what the chat shows it waiting on, so it goes once that is gone. */
export function useNativeChatComposerError(
  causes: StructuredConversationCommandCauses,
  authoritative = true
): {
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  reportComposerError: NativeChatStructuredComposerTransport['onError']
} {
  const [line, setLine] = useNativeChatReturnState(errorLine, () => null)
  const reportComposerError = useCallback<NativeChatStructuredComposerTransport['onError']>(
    (text, detail) =>
      setLine(
        text === null
          ? null
          : {
              text,
              ...(detail?.errorText ? { errorText: detail.errorText } : {}),
              ...(detail?.refusedWhile ? { refusedWhile: detail.refusedWhile } : {})
            }
      ),
    []
  )
  const shown =
    line !== null && (!authoritative || !line.refusedWhile || causes[line.refusedWhile])
      ? line
      : null
  // Dropped, not hidden: the cause coming back later is not what this refusal was about.
  if (authoritative && line !== null && shown === null) {
    setLine(null)
  }
  const composerError = useMemo(
    () =>
      shown
        ? {
            text: shown.text,
            ...(shown.errorText ? { errorText: shown.errorText } : {}),
            onDismiss: () => setLine(null)
          }
        : null,
    [shown]
  )
  return { composerError, reportComposerError }
}
