// What the notice card above a native chat's composer shows: Orca's own words, plus, apart from
// them, any error text Orca did not write, so it can be read and copied as written.

import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { isClipboardTextTooLargeError } from '../../../../shared/clipboard-text'

export type NativeChatComposerNoticeContent = {
  text: string
  /** Text from outside Orca (a host or system error), shown apart and copyable. */
  errorText?: string
}

export type NativeChatComposerNotice = NativeChatComposerNoticeContent & {
  key: string
  action?: { label: string; onClick: () => void; disabled?: boolean }
  onDismiss?: () => void
} & ({ kind: 'error' | 'attachment' } | { kind: 'host'; tone: 'warning' | 'muted' })

/** `headline` in Orca's words, with the error as written beside it. `localErrorIsOrcaWords`: an
 *  error raised in this window (not wrapped by main-process IPC) is already Orca's sentence. */
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

/** A failed paste: an error this window raised, or Orca's own size limit coming back from the main
 *  process, is already Orca's sentence; any other is kept apart under `headline`. */
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
