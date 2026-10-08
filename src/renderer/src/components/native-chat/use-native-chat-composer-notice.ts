import { useCallback, useMemo, useState } from 'react'
import type {
  NativeChatComposerNotice,
  NativeChatComposerNoticeContent
} from './native-chat-composer-notice'

/** The composer's own paste and attachment notice, after the chat's notices. */
export function useNativeChatComposerNotice(chatNotices?: readonly NativeChatComposerNotice[]): {
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
    [chatNotices, notice, setNotice]
  )
  return { notices, setNotice }
}

/** A chat's last send or command error: shown in the card until dismissed or the next send clears
 *  it. */
export function useNativeChatComposerError(): {
  composerError: (NativeChatComposerNoticeContent & { onDismiss: () => void }) | null
  reportComposerError: (text: string | null, errorText?: string) => void
} {
  const [content, setContent] = useState<NativeChatComposerNoticeContent | null>(null)
  const reportComposerError = useCallback(
    (text: string | null, errorText?: string) =>
      setContent(text === null ? null : { text, ...(errorText ? { errorText } : {}) }),
    []
  )
  const composerError = useMemo(
    () => (content ? { ...content, onDismiss: () => setContent(null) } : null),
    [content]
  )
  return { composerError, reportComposerError }
}
