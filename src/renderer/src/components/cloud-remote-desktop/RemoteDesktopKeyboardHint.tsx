import { useEffect, useState, type MutableRefObject } from 'react'
import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { isMacUserAgent } from '@/lib/user-agent-platform'
import { cn } from '@/lib/utils'

/** Main's release chord (remote-desktop-keyboard.ts), as the person presses it. */
export function remoteDesktopReleaseChordLabel(mac: boolean = isMacUserAgent()): string {
  return mac ? '⌃⌘' : 'Ctrl+Alt'
}

const CAPTURED_HINT_MS = 4_000
const RELEASED_HINT_MS = 2_500

type HintKind = 'captured' | 'released'

export function RemoteDesktopKeyboardHintView({
  kind,
  visible,
  chord
}: {
  kind: HintKind
  visible: boolean
  chord: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      aria-hidden={!visible}
      className={cn(
        'pointer-events-none absolute inset-x-2 top-2 z-20 mx-auto w-fit rounded-md border border-border bg-popover/95 px-2.5 py-1 text-center text-xs text-balance text-popover-foreground shadow-md motion-safe:transition-opacity motion-safe:duration-200',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      {kind === 'captured' ? (
        <Trans
          i18n={i18n}
          defaults={t(
            'components.cloudRemoteDesktop.keyboardCaptured',
            'Keys go to the remote desktop. Press <kbd>{{chord}}</kbd> to use Orca shortcuts.',
            { chord }
          )}
          components={{
            kbd: (
              <kbd className="mx-0.5 inline-flex h-4 items-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium" />
            )
          }}
        />
      ) : (
        t(
          'components.cloudRemoteDesktop.keyboardReleased',
          'Orca shortcuts are back. Click the desktop to type in it.'
        )
      )}
    </div>
  )
}

/**
 * A remote desktop page keeps every key while focused (main stops forwarding Orca's shortcuts).
 * Shows how to get them back when the desktop takes the keyboard, and moves focus out of the page
 * when main reports the release chord.
 */
export function RemoteDesktopKeyboardHint({
  browserPageId,
  webviewRef
}: {
  browserPageId: string
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
}): React.JSX.Element | null {
  const [desktop, setDesktop] = useState(false)
  // Kept after it hides so the text does not change while it fades out.
  const [hint, setHint] = useState<{ kind: HintKind; until: number; visible: boolean }>({
    kind: 'captured',
    until: 0,
    visible: false
  })

  useEffect(() => {
    let wasCaptured = false
    // Once per page load and after each release: not on every click back into the desktop.
    let hintDue = true
    const unsubscribeState = window.api.browser.onRemoteDesktopState((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      setDesktop(event.desktop)
      if (!event.desktop) {
        hintDue = true
      }
      if (event.captured && !wasCaptured && hintDue) {
        hintDue = false
        setHint({ kind: 'captured', until: Date.now() + CAPTURED_HINT_MS, visible: true })
      } else if (!event.captured) {
        setHint((current) =>
          current.kind === 'captured' ? { ...current, visible: false } : current
        )
      }
      wasCaptured = event.captured
    })
    const unsubscribeRelease = window.api.browser.onRemoteDesktopRelease((event) => {
      if (event.browserPageId !== browserPageId) {
        return
      }
      // Focus leaves the page, so keys reach Orca's window again.
      webviewRef.current?.blur()
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      hintDue = true
      setHint({ kind: 'released', until: Date.now() + RELEASED_HINT_MS, visible: true })
    })
    return () => {
      unsubscribeState()
      unsubscribeRelease()
    }
  }, [browserPageId, webviewRef])

  useEffect(() => {
    if (!hint.visible) {
      return
    }
    const timer = setTimeout(
      () => setHint((current) => ({ ...current, visible: false })),
      Math.max(0, hint.until - Date.now())
    )
    return () => clearTimeout(timer)
  }, [hint])

  if (!desktop) {
    return null
  }
  return (
    <RemoteDesktopKeyboardHintView
      kind={hint.kind}
      visible={hint.visible}
      chord={remoteDesktopReleaseChordLabel()}
    />
  )
}
