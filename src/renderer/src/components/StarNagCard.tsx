import { useEffect, useState } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { useAppStore } from '../store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

const ORCA_STARGAZERS_URL = 'https://github.com/stablyai/orca/stargazers'
type StarNagMode = 'gh' | 'web'

/**
 * Persistent "star Orca on GitHub" notification card.
 *
 * Rendered at the bottom-right of the app (alongside UpdateCard). It is
 * intentionally non-auto-dismissing: the user must either click Star or the
 * close button. Dismissing doubles the next-trigger threshold in the main
 * process so the nag backs off exponentially.
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
    return window.api.starNag.onShow((payload) => {
      setMode(payload?.mode === 'web' ? 'web' : 'gh')
      setVisible(true)
    })
  }, [])

  const handleClose = (): void => {
    setVisible(false)
    // Why: fire-and-forget. If persisting the dismissal fails the worst case
    // is we re-fire the same threshold on next launch — not worth blocking
    // the close animation on.
    void window.api.starNag.dismiss()
  }

  const handleDisable = (): void => {
    setVisible(false)
    void window.api.starNag.disable()
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleClose closes
    // over stable refs; re-binding on each render is unnecessary.
  }, [visible])

  if (!visible) {
    return null
  }

  const handleStar = async (): Promise<void> => {
    if (busy) {
      return
    }
    if (mode === 'web') {
      setBusy(true)
      await window.api.shell.openUrl(ORCA_STARGAZERS_URL)
      await window.api.starNag.disable()
      if (mountedRef.current) {
        setBusy(false)
        setVisible(false)
      }
      return
    }
    setBusy(true)
    const ok = await window.api.gh.starOrca('star_nag')
    if (mountedRef.current) {
      setBusy(false)
    }
    if (!ok) {
      if (mountedRef.current) {
        setMode('web')
      }
      return
    }
    await window.api.starNag.complete()
    if (mountedRef.current) {
      setVisible(false)
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
              aria-label={translate('auto.components.StarNagCard.b5e685e4d9', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.StarNagCard.30c36231c1',
              'If Orca has saved you time, a GitHub star goes a long way. It helps other developers discover the project and keeps the team motivated to ship improvements.'
            )}
          </p>

          <Button
            variant="default"
            size="sm"
            onClick={() => void handleStar()}
            disabled={busy}
            className="mt-0.5 w-full gap-1.5"
          >
            {mode === 'web' ? <ExternalLink className="size-3.5" /> : <Star className="size-3.5" />}
            {busy
              ? mode === 'web'
                ? translate('auto.components.StarNagCard.d32015fec7', 'Opening...')
                : translate('auto.components.StarNagCard.af3c9bbb37', 'Starring…')
              : mode === 'web'
                ? translate('auto.components.StarNagCard.157bb5ecbb', 'Open GitHub')
                : translate('auto.components.StarNagCard.2d67b6c849', 'Star on GitHub')}
          </Button>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleClose}>
              {translate('auto.components.StarNagCard.8c967b4d15', 'Not now')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={handleDisable}>
              {translate('auto.components.StarNagCard.73dfd4eb8d', "Don't ask again")}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
