import type React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Star } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../../ui/button'
import { useTranslate } from '@/i18n/use-translate'

// Do not deep-link to /stargazers: GitHub 404s that page for users without repo write access.
const ORCA_GITHUB_URL = 'https://github.com/stablyai/orca'

type SupportState =
  | 'loading'
  | 'not-starred'
  | 'web-fallback'
  | 'opening-github'
  | 'starring'
  | 'starred'
  | 'hidden'

/** The About group's quiet Star action, on the header's right edge. */
export function GeneralSupportStarAction(): React.JSX.Element | null {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  // Keep gh-derived state local; nothing renders until the starred check returns.
  const [starState, setStarState] = useState<SupportState>('loading')

  useEffect(() => {
    let cancelled = false
    void window.api.gh.checkOrcaStarred().then((result) => {
      if (cancelled) {
        return
      }
      if (result === null) {
        setStarState('web-fallback')
      } else {
        setStarState(result ? 'starred' : 'not-starred')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleStarClick = async (): Promise<void> => {
    if (starState === 'web-fallback') {
      setStarState('opening-github')
      await window.api.shell.openUrl(ORCA_GITHUB_URL)
      if (mountedRef.current) {
        setStarState('web-fallback')
      }
      return
    }
    if (starState !== 'not-starred') {
      return
    }
    setStarState('starring')
    const ok = await window.api.gh.starOrca('settings')
    if (!ok) {
      if (mountedRef.current) {
        setStarState('web-fallback')
      }
      return
    }
    if (mountedRef.current) {
      setStarState('starred')
    }
    // Starring here must also silence the threshold-based popup permanently.
    await window.api.starNag.complete()
  }

  if (starState === 'loading' || starState === 'hidden') {
    return null
  }
  if (starState === 'starred') {
    return (
      <span
        role="status"
        aria-live="polite"
        className="inline-flex h-6 items-center gap-1 px-2 text-xs font-medium text-status-warning-text animate-in fade-in duration-300"
      >
        <Star className="size-3 fill-current" aria-hidden="true" />
        {t('settings.about.star.starred', 'Starred')}
      </span>
    )
  }
  const pending = starState === 'starring' || starState === 'opening-github'
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="xs"
      onClick={() => void handleStarClick()}
      disabled={pending}
      aria-label={t(
        'auto.components.settings.GeneralSupportSection.6922c1fa2b',
        'Star Orca on GitHub'
      )}
    >
      {pending ? (
        <Loader2 className="animate-spin" />
      ) : starState === 'web-fallback' ? (
        <ExternalLink />
      ) : (
        <Star />
      )}
      {t('auto.components.settings.GeneralSupportSection.964acc6bb4', 'Star')}
    </Button>
  )
}
