import { useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, Loader2, Star, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

const ORCA_REPO_URL = 'https://github.com/stablyai/orca'
type StarNagMode = 'gh' | 'web'
type StarNagToastStatus = 'idle' | 'busy' | 'starred' | 'opened'

type StarNagToastProps = {
  id: string | number
  mode: StarNagMode
  markResolved: () => void
  setDismissSuppressed: (suppressed: boolean) => void
}

function StarNagToast({
  id,
  mode: initialMode,
  markResolved,
  setDismissSuppressed
}: StarNagToastProps): React.JSX.Element {
  const [mode, setMode] = useState(initialMode)
  const [status, setStatus] = useState<StarNagToastStatus>('idle')
  const busy = status === 'busy'

  const close = (): void => {
    if (busy) {
      return
    }
    toast.dismiss(id)
  }

  const later = (): void => {
    if (busy) {
      return
    }
    markResolved()
    void window.api.starNag.later()
    toast.dismiss(id)
  }

  const act = async (): Promise<void> => {
    if (busy || status === 'starred') {
      return
    }
    setStatus('busy')
    setDismissSuppressed(true)
    if (mode === 'web') {
      try {
        await window.api.shell.openUrl(ORCA_REPO_URL)
        await window.api.starNag.openWeb()
        markResolved()
        setStatus('opened')
      } catch {
        setDismissSuppressed(false)
        setStatus('idle')
      }
      return
    }
    let ok = false
    try {
      ok = await window.api.starNag.starOrca()
    } catch {
      ok = false
    }
    if (!ok) {
      setMode('web')
      setDismissSuppressed(false)
      setStatus('idle')
      return
    }
    markResolved()
    setStatus('starred')
  }

  const actionLabel =
    status === 'starred'
      ? translate('auto.components.star.nag.StarNagToastHost.starredThanks', 'Starred — thank you!')
      : status === 'opened'
        ? translate('auto.components.star.nag.StarNagToastHost.githubOpened', 'GitHub opened')
        : busy
          ? mode === 'web'
            ? translate('auto.components.star.nag.StarNagToastHost.opening', 'Opening…')
            : translate('auto.components.star.nag.StarNagToastHost.starring', 'Starring…')
          : mode === 'web'
            ? translate('auto.components.star.nag.StarNagToastHost.openGithub', 'Open GitHub')
            : translate('auto.components.star.nag.StarNagToastHost.starOnGithub', 'Star on GitHub')

  const completedStar = status === 'starred'
  const primaryActionClass = completedStar
    ? 'min-w-0 flex-1 gap-1.5 border-amber-400/40 bg-amber-400/15 text-amber-700 hover:bg-amber-400/15 dark:text-amber-200'
    : 'min-w-0 flex-1 gap-1.5 border-amber-400/60 bg-amber-400/15 text-amber-800 hover:bg-amber-400/25 dark:text-amber-100'

  return (
    <div className="relative w-[340px] max-w-[calc(100vw-32px)] overflow-hidden rounded-lg border border-border bg-popover p-3.5 text-popover-foreground shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-center gap-2">
            <span
              className={
                completedStar
                  ? 'flex size-6 shrink-0 items-center justify-center rounded-full border border-amber-400/40 bg-amber-400/10 text-amber-500'
                  : 'flex size-6 shrink-0 items-center justify-center rounded-full border border-status-success-border bg-status-success-background text-status-success'
              }
              aria-hidden="true"
            >
              {completedStar ? (
                <Star className="size-3.5 fill-current" />
              ) : (
                <Check className="size-3.5" />
              )}
            </span>
            <div className="text-sm font-semibold">
              {translate(
                'auto.components.star.nag.StarNagToastHost.onboardingCompleted',
                'Onboarding completed!'
              )}
            </div>
          </div>
          <p className="text-sm leading-5 text-muted-foreground">
            {translate(
              'auto.components.star.nag.StarNagToastHost.body',
              'If you’re enjoying Orca so far, a GitHub star helps other developers discover it.'
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={close}
          disabled={busy}
          aria-label={translate('auto.components.star.nag.StarNagToastHost.dismiss', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="default"
          size="sm"
          className={primaryActionClass}
          onClick={() => void act()}
          disabled={busy || status === 'starred' || status === 'opened'}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : mode === 'web' ? (
            <ExternalLink className="size-3.5" />
          ) : (
            <Star className="size-3.5" />
          )}
          {actionLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="w-[84px]"
          onClick={later}
          disabled={busy || status === 'starred' || status === 'opened'}
        >
          {translate('auto.components.star.nag.StarNagToastHost.later', 'Later')}
        </Button>
      </div>
    </div>
  )
}

export function StarNagToastHost(): null {
  const activeToastIdRef = useRef<string | number | null>(null)
  const activeToastResolvedRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const dismissActiveToast = (): void => {
      if (activeToastIdRef.current === null) {
        return
      }
      activeToastResolvedRef.current?.()
      toast.dismiss(activeToastIdRef.current)
    }
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface !== 'toast') {
        return
      }
      dismissActiveToast()
      let resolved = false
      let dismissSuppressed = false
      const markResolved = (): void => {
        resolved = true
      }
      const setDismissSuppressed = (suppressed: boolean): void => {
        dismissSuppressed = suppressed
      }
      activeToastResolvedRef.current = markResolved
      const id = toast.custom(
        (toastId) => (
          <StarNagToast
            id={toastId}
            mode={payload.mode === 'web' ? 'web' : 'gh'}
            markResolved={markResolved}
            setDismissSuppressed={setDismissSuppressed}
          />
        ),
        {
          duration: Infinity,
          closeButton: false,
          dismissible: false,
          unstyled: true,
          onDismiss: () => {
            if (activeToastIdRef.current === id) {
              activeToastIdRef.current = null
              activeToastResolvedRef.current = null
            }
            if (!resolved && !dismissSuppressed) {
              void window.api.starNag.dismiss()
            }
          },
          onAutoClose: () => {
            if (activeToastIdRef.current === id) {
              activeToastIdRef.current = null
              activeToastResolvedRef.current = null
            }
          }
        }
      )
      activeToastIdRef.current = id
    })
    const unsubscribeHide = window.api.starNag.onHide(dismissActiveToast)
    return () => {
      unsubscribeShow()
      unsubscribeHide()
    }
  }, [])

  return null
}
