import { useCallback, useMemo, useState } from 'react'
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

/** The composer's own paste and attachment notice, after the chat's notices and the input hold. */
export function useNativeChatComposerNotice(
  chatNotices?: readonly NativeChatComposerNotice[],
  holdNotice?: NativeChatComposerNotice | null
): {
  notices: readonly NativeChatComposerNotice[]
  setNotice: (text: string | null, errorText?: string) => void
} {
  const [notice, setNoticeContent] = useState<NativeChatComposerNoticeContent | null>(null)
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

/** Retain send/command errors until dismissed or replaced; drop refusals when their visible blocking cause ends. */
export function useNativeChatComposerError(causes: StructuredConversationCommandCauses): {
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  reportComposerError: NativeChatStructuredComposerTransport['onError']
} {
  const [line, setLine] = useState<ComposerErrorLine | null>(null)
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
  const shown = line !== null && (!line.refusedWhile || causes[line.refusedWhile]) ? line : null
  // Dropped, not hidden: the cause coming back later is not what this refusal was about.
  if (line !== null && shown === null) {
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
