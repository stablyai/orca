// Separate Orca’s notice wording from verbatim external errors so the latter stay readable and copyable.

import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isClipboardTextTooLargeError } from '../../../../shared/clipboard-text'

export type NativeChatComposerNoticeContent = {
  text: string
  /** Inline presentation of the sentence when it contains navigation. */
  content?: React.ReactNode
  /** Text from outside Orca (a host or system error), shown apart and copyable. */
  errorText?: string
}

export type NativeChatComposerNotice = NativeChatComposerNoticeContent & {
  key: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
  onDismiss?: () => void
} & ({ kind: 'error' | 'attachment' | 'device' } | { kind: 'host'; tone: 'warning' | 'muted' })

/** Keep external errors apart from headline; localErrorIsOrcaWords identifies already-worded renderer errors. */
export function nativeChatNoticeFromError(
  error: unknown,
  headline: string,
  options: { localErrorIsOrcaWords?: boolean } = {}
): NativeChatComposerNoticeContent {
  const detail = error instanceof Error ? readIpcErrorDetail(error) : String(error ?? '').trim()
  if (!detail) {
    return { text: headline }
  }
  const wrapped = error instanceof Error && detail !== error.message.trim()
  return options.localErrorIsOrcaWords && error instanceof Error && !wrapped
    ? { text: detail }
    : { text: headline, errorText: detail }
}

/** Says `headline` through a notice setter, with the error's own text apart when it has any. */
export function setNativeChatNoticeFromError(
  setNotice: (text: string | null, errorText?: string) => void,
  error: unknown,
  headline: string,
  options: { localErrorIsOrcaWords?: boolean } = {}
): void {
  const notice = nativeChatNoticeFromError(error, headline, options)
  if (notice.errorText) {
    setNotice(notice.text, notice.errorText)
  } else {
    setNotice(notice.text)
  }
}

/** Local errors and main’s size refusals already use Orca wording; keep other paste errors apart under headline. */
export function setNativeChatPasteFailure(
  setNotice: (text: string | null, errorText?: string) => void,
  error: unknown,
  headline = translate('components.native-chat.composer.pasteFailed', 'Paste failed.')
): void {
  if (isClipboardTextTooLargeError(error)) {
    setNotice(readIpcErrorDetail(error) ?? headline)
    return
  }
  setNativeChatNoticeFromError(setNotice, error, headline, { localErrorIsOrcaWords: true })
}
