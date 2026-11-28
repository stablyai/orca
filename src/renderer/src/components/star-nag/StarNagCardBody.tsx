import { useCallback, useEffect } from 'react'
import { ExternalLink, Star, X } from 'lucide-react'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { runWithFinally } from '@/lib/run-with-finally'

export type StarNagMode = 'gh' | 'web'

export function StarNagCardBody({
  mode,
  busy,
  onSetMode,
  onSetBusy,
  onSetVisible,
  openRepoUrl
}: {
  mode: StarNagMode
  busy: boolean
  onSetMode: (mode: StarNagMode) => void
  onSetBusy: (busy: boolean) => void
  onSetVisible: (visible: boolean) => void
  openRepoUrl: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()

  const handleClose = useCallback((): void => {
    if (busy) {
      return
    }
    onSetVisible(false)
    // Do not block closing on persistence; failure only risks prompting at the same threshold next launch.
    void window.api.starNag.dismiss()
  }, [busy, onSetVisible])

  const handleLater = (): void => {
    if (busy) {
      return
    }
    onSetVisible(false)
    void window.api.starNag.later()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handleClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  const primaryActionClass =
    'min-w-0 flex-1 gap-1.5 border-amber-400/60 bg-amber-400/15 text-amber-800 hover:bg-amber-400/25 dark:text-amber-100'

  const handleStar = async (): Promise<void> => {
    if (busy) {
      return
    }
    const openGithubFallback = async (): Promise<boolean> => {
      try {
        await openRepoUrl()
        await window.api.starNag.openWeb()
        if (mountedRef.current) {
          onSetVisible(false)
        }
        return true
      } catch {
        // Retain the prompt if browser handoff fails so users can retry or choose another action.
        return false
      }
    }
    if (mode === 'web') {
      onSetBusy(true)
      await runWithFinally(
        () => openGithubFallback(),
        () => {
          if (mountedRef.current) {
            onSetBusy(false)
          }
        }
      )
      return
    }
    onSetBusy(true)
    let ok = false
    try {
      ok = await window.api.starNag.starOrca()
    } catch {
      ok = false
    }
    await runWithFinally(
      async () => {
        if (!ok) {
          // A failed direct star falls back to explicit browser handoff.
          if (mountedRef.current) {
            onSetMode('web')
          }
          return
        }
        if (mountedRef.current) {
          onSetVisible(false)
        }
      },
      () => {
        if (mountedRef.current) {
          onSetBusy(false)
        }
      }
    )
  }

  return (
    <div>
      <Card className="py-0 gap-0" role="complementary" aria-labelledby="star-nag-heading">
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Star className="size-4 fill-amber-400/60 text-amber-400/80" />
              <h3 id="star-nag-heading" className="text-sm font-semibold">
                {t('auto.components.StarNagCard.5f6df21046', 'Enjoying Orca?')}
              </h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleClose}
              disabled={busy}
              aria-label={t('auto.components.StarNagCard.b5e685e4d9', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {t(
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
                  ? t('auto.components.StarNagCard.d32015fec7', 'Opening...')
                  : t('auto.components.StarNagCard.af3c9bbb37', 'Starring…')
                : mode === 'web'
                  ? t('auto.components.StarNagCard.157bb5ecbb', 'Open GitHub')
                  : t('auto.components.StarNagCard.2d67b6c849', 'Star on GitHub')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="w-[84px]"
              onClick={handleLater}
              disabled={busy}
            >
              {t('auto.components.StarNagCard.8c967b4d15', 'Later')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
