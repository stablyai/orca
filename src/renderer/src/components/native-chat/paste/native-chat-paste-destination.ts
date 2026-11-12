import { currentDraftScope } from '../drafts/native-chat-launch-draft-source'
import { insertNativeChatComposerDraftText } from '../drafts/native-chat-composer-draft-insertion'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { captureNativeChatEditDraftDestination } from '../drafts/native-chat-composer-draft-memory'
import { nativeChatPasteUnavailableNotice } from '@/components/native-chat/paste/native-chat-paste-request'

function captureNativeChatPasteDestination(
  scope: string | undefined,
  lifetime: { active: boolean },
  canPaste: () => boolean,
  insertTypedText: (text: string) => boolean,
  setNotice: (notice: string | null) => void
) {
  const destination = scope ? captureNativeChatEditDraftDestination(scope) : undefined
  const canComplete = (): boolean => (destination ? destination.active : canPaste())
  const insertCapturedText = (text: string): void => {
    if (!text || !canComplete()) {
      return
    }
    if (
      (!destination || destination.scopeKey === currentDraftScope(scope ?? '')) &&
      lifetime.active &&
      insertTypedText(text)
    ) {
      return
    }
    if (destination) {
      insertNativeChatComposerDraftText(destination.scopeKey, text, { paste: true })
    } else {
      setNotice(nativeChatPasteUnavailableNotice())
    }
  }
  const showPasteUnavailable = (): void => {
    if (lifetime.active) {
      setNotice(nativeChatPasteUnavailableNotice())
    }
  }
  return { canComplete, insertCapturedText, showPasteUnavailable }
}

export function useNativeChatPasteDestination(
  scope: string | undefined,
  lifetime: { active: boolean },
  disabled: boolean,
  insertTypedText: (text: string) => boolean,
  setNotice: (notice: string | null) => void
) {
  const disabledRef = useRef(disabled)
  useLayoutEffect(() => {
    disabledRef.current = disabled
  }, [disabled])
  const canPaste = useCallback(() => lifetime.active && !disabledRef.current, [lifetime])
  const captured = useMemo(
    () => captureNativeChatPasteDestination(scope, lifetime, canPaste, insertTypedText, setNotice),
    [scope, lifetime, canPaste, insertTypedText, setNotice]
  )
  return { canPaste, ...captured }
}
