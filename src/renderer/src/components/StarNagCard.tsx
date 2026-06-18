import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { useAppStore } from '../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const ORCA_REPO_URL = 'https://github.com/stablyai/orca'
type StarNagMode = 'gh' | 'web'

/**
 * Persistent "star Orca on GitHub" notification card.
 *
 * Rendered at the bottom-right of the app (alongside UpdateCard). It is
 * intentionally non-auto-dismissing: the user must either click Star, defer,
 * confirm an existing star, or close the card. Nonterminal exits set a
 * persisted cooldown in the main process.
 *
 * Visibility is driven by the main-process 'star-nag:show' IPC event — this
 * component does no threshold math or gh-CLI checks locally.
 */
export function StarNagCard(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<StarNagMode>('gh')
  const mountedRef = useMountedRef()
  // Why: UpdateCard lives at the same bottom-right slot. When it is visible
  // (any non-idle / non-not-available state), stack the star-nag card above
  // it instead of overlapping — we must not cover a pending update prompt
  // because that's a higher-priority action.
  const updateStatus = useAppStore((s) => s.updateStatus)
  const updateCardVisible = updateStatus.state !== 'idle' && updateStatus.state !== 'not-available'

  useEffect(() => {
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface && payload.surface !== 'card') {
        setBusy(false)
        setVisible(false)
        return
      }
      setMode(payload?.mode === 'web' ? 'web' : 'gh')
      setVisible(true)
    })
    const unsubscribeHide = window.api.starNag.onHide(() => {
      setBusy(false)
      setVisible(false)
    })
    return () => {
      unsubscribeShow()
      unsubscribeHide()
    }
  }, [])

  const handleClose = useCallback((): void => {
    if (busy) {
      return
    }
    setVisible(false)
    // Why: fire-and-forget. If persisting the dismissal fails the worst case
    // is we re-fire the same threshold on next launch — not worth blocking
    // the close animation on.
    void window.api.starNag.dismiss()
  }, [busy])

  const handleLater = (): void => {
    if (busy) {
      return
    }
    setVisible(false)
    void window.api.starNag.later()
  }

  useEffect(() => {
    if (!visible) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleClose, visible])

  if (!visible) {
    return null
  }

  const primaryActionClass =
    'min-w-0 flex-1 gap-1.5 border-amber-400/60 bg-amber-400/15 text-amber-800 hover:bg-amber-400/25 dark:text-amber-100'

  const handleStar = async (): Promise<void> => {
    if (busy) {
      return
    }
    const openGithubFallback = async (): Promise<boolean> => {
      try {
        await window.api.shell.openUrl(ORCA_REPO_URL)
        await window.api.starNag.openWeb()
        if (mountedRef.current) {
          setVisible(false)
        }
        return true
      } catch {
        // Why: failing to open the external browser is recoverable; keep the
        // prompt available so the user can retry or choose another action.
        return false
      }
    }
    if (mode === 'web') {
      setBusy(true)
      try {
        await openGithubFallback()
      } finally {
        if (mountedRef.current) {
          setBusy(false)
        }
      }
      return
    }
    setBusy(true)
    let ok = false
    try {
      ok = await window.api.starNag.starOrca()
    } catch {
      ok = false
    }
    try {
      if (!ok) {
        // Why: preflight chooses whether direct starring should be offered. If
        // the later star call fails, let the user choose the browser handoff.
        if (mountedRef.current) {
          setMode('web')
        }
        return
      }
      if (mountedRef.current) {
        setVisible(false)
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div
      // Why: when UpdateCard is up, it occupies bottom-10. Raise the star-nag
      // card above it so both are visible — the update action stays on top
      // visually (it's the higher-priority one) and the star-nag sits above.
      className={`fixed right-4 z-40 w-[360px] max-w-[calc(100vw-32px)]
      max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto ${
        updateCardVisible ? 'bottom-[220px]' : 'bottom-10'
      }`}
    >
      <Card className="py-0 gap-0" role="complementary" aria-labelledby="star-nag-heading">
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Star className="size-4 fill-amber-400/60 text-amber-400/80" />
              <h3 id="star-nag-heading" className="text-sm font-semibold">
                {translate('auto.components.StarNagCard.5f6df21046', 'Enjoying Orca?')}
              </h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleClose}
              disabled={busy}
              aria-label={translate('auto.components.StarNagCard.b5e685e4d9', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.StarNagCard.30c36231c1',
              'Orca is open source. If it helped today, a GitHub star helps other developers find it.'
            )}
          </p>

          <div className="mt-0.5 flex gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleStar()}
              disabled={busy}
              className={primaryActionClass}
            >
              {mode === 'web' ? (
                <ExternalLink className="size-3.5" />
              ) : (
                <Star className="size-3.5" />
              )}
              {busy
                ? mode === 'web'
                  ? translate('auto.components.StarNagCard.d32015fec7', 'Opening...')
                  : translate('auto.components.StarNagCard.af3c9bbb37', 'Starring…')
                : mode === 'web'
                  ? translate('auto.components.StarNagCard.157bb5ecbb', 'Open GitHub')
                  : translate('auto.components.StarNagCard.2d67b6c849', 'Star on GitHub')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="w-[84px]"
              onClick={handleLater}
              disabled={busy}
            >
              {translate('auto.components.StarNagCard.8c967b4d15', 'Later')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
