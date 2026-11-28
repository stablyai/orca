import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { useAppStore } from '@/store'
import { restoreTerminalFitToDesktop } from '../../terminal-pane/viewport/terminal-fit-restore'
import type { NativeChatComposerNotice } from '../composer/controls/native-chat-composer-notice'
import { useNativeChatViewGuard } from '../pane/ownership/native-chat-view-memory'

/** Chat hides the terminal’s phone overlay and drafts hide its placeholder; keep the lock and Take back action in a notice. */
export function useNativeChatMobileHoldNotice(
  ptyId: string | null,
  canSend: boolean
): NativeChatComposerNotice | null {
  // Kept with the chat tab: a view released mid take-back returns still pending, and the settle clears it.
  const [pending, setPending] = useNativeChatViewGuard('mobile-hold-take-back', false)
  // Memoized so the composer's notice list keeps its identity across unrelated renders.
  return useMemo(() => {
    if (ptyId === null || canSend) {
      return null
    }
    return nativeChatMobileHoldNotice(pending, () => {
      setPending(true)
      void restoreTerminalFitToDesktop(ptyId, useAppStore.getState().settings ?? undefined)
        .then((restored) => {
          if (restored) {
            requestAnimationFrame(refitAndRefreshAllTerminalPanes)
          }
        })
        .finally(() => setPending(false))
    })
  }, [ptyId, canSend, pending, setPending])
}

export function nativeChatMobileHoldNotice(
  pending: boolean,
  onTakeBack: () => void,
  t: Translate = translate
): NativeChatComposerNotice {
  return {
    key: 'mobile-hold',
    kind: 'device',
    text: t('components.native-chat.composer.locked', 'Input is held by another device.'),
    action: {
      label: t('auto.components.terminal.pane.MobileDriverOverlay.c6460cf584', 'Take back'),
      onClick: onTakeBack,
      disabled: pending
    }
  }
}
