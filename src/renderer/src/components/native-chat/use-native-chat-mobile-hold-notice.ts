import { useMemo, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { refitAndRefreshAllTerminalPanes } from '@/lib/pane-manager/pane-manager-registry'
import { useAppStore } from '@/store'
import { restoreTerminalFitToDesktop } from '../terminal-pane/terminal-fit-restore'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

/** Chat hides the terminal’s phone overlay and drafts hide its placeholder; keep the lock and Take back action in a notice. */
export function useNativeChatMobileHoldNotice(
  ptyId: string | null,
  canSend: boolean
): NativeChatComposerNotice | null {
  const [pending, setPending] = useState(false)
  const mountedRef = useMountedRef()
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
        .finally(() => {
          if (mountedRef.current) {
            setPending(false)
          }
        })
    })
  }, [ptyId, canSend, pending, mountedRef])
}

export function nativeChatMobileHoldNotice(
  pending: boolean,
  onTakeBack: () => void
): NativeChatComposerNotice {
  return {
    key: 'mobile-hold',
    kind: 'device',
    text: translate('components.native-chat.composer.locked', 'Input is held by another device.'),
    action: {
      label: translate('auto.components.terminal.pane.MobileDriverOverlay.c6460cf584', 'Take back'),
      onClick: onTakeBack,
      disabled: pending
    }
  }
}
