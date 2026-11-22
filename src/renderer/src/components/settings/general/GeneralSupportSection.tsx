import type React from 'react'
import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Star } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
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

type GeneralSupportSectionProps = {
  inline?: boolean
  hasPrecedingSections: boolean
}

export function GeneralSupportSection({
  hasPrecedingSections,
  inline
}: GeneralSupportSectionProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  // Keep gh-derived state local; use a same-size placeholder that collapses with its divider when the section is hidden.
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

  return (
    <SupportSection
      inline={inline}
      state={starState}
      hasPrecedingSections={hasPrecedingSections}
      onStarClick={handleStarClick}
    />
  )
}

type SupportSectionProps = {
  state: SupportState
  inline?: boolean
  hasPrecedingSections: boolean
  onStarClick: () => void | Promise<void>
}

function SupportSection({
  state,
  inline,
  hasPrecedingSections,
  onStarClick
}: SupportSectionProps): React.JSX.Element | null {
  const t = useTranslate()
  // Collapse the leading gap too when gh is unavailable or the repo was already starred.
  const collapsed = state === 'hidden'
  if (inline) {
    if (state === 'hidden') {
      return null
    }
    return state === 'loading' ? (
      <SupportRowSkeleton />
    ) : (
      <SupportRow state={state} onStarClick={onStarClick} />
    )
  }

  return (
    <section
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
        collapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
      }`}
      aria-hidden={collapsed}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={hasPrecedingSections ? 'pt-2' : undefined}>
          <SettingsGroup
            title={t('auto.components.settings.GeneralSupportSection.55a87e5fd1', 'Support Orca')}
          >
            {state === 'loading' ? <SupportRowSkeleton /> : null}
            {state !== 'loading' && state !== 'hidden' ? (
              <SupportRow state={state} onStarClick={onStarClick} />
            ) : null}
          </SettingsGroup>
        </div>
      </div>
    </section>
  )
}

function SupportRowSkeleton(): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2" aria-hidden="true">
      <div className="h-4 w-36 rounded bg-muted/50 animate-pulse" />
      <div className="h-8 w-24 rounded-md bg-muted/50 animate-pulse" />
    </div>
  )
}

function SupportRow({
  state,
  onStarClick
}: {
  state: 'not-starred' | 'web-fallback' | 'opening-github' | 'starring' | 'starred'
  onStarClick: () => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  // Keep the setting label stable; only its action changes to confirmation after starring.
  return (
    <SearchableSetting
      title={t('auto.components.settings.GeneralSupportSection.6922c1fa2b', 'Star Orca on GitHub')}
      description={t(
        'auto.components.settings.GeneralSupportSection.511782265b',
        'Support the project with a GitHub star.'
      )}
      keywords={['about', 'star', 'github', 'support', 'feedback', 'like']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <Label>
        {t('auto.components.settings.GeneralSupportSection.6922c1fa2b', 'Star Orca on GitHub')}
      </Label>
      {state === 'starred' ? (
        <SupportRowThanks />
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onStarClick()}
          disabled={state === 'starring' || state === 'opening-github'}
          className="shrink-0 gap-1.5"
        >
          {state === 'starring' || state === 'opening-github' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : state === 'web-fallback' ? (
            <ExternalLink className="size-3.5" />
          ) : (
            <Star className="size-3.5 fill-amber-400 text-amber-400" />
          )}
          {state === 'starring'
            ? t('auto.components.settings.GeneralSupportSection.397719bee5', 'Starring...')
            : state === 'opening-github'
              ? t('auto.components.settings.GeneralSupportSection.cb65c75b11', 'Opening...')
              : state === 'web-fallback'
                ? t('auto.components.settings.GeneralSupportSection.f2d4f877b2', 'Open GitHub')
                : t('auto.components.settings.GeneralSupportSection.964acc6bb4', 'Star')}
        </Button>
      )}
    </SearchableSetting>
  )
}

function SupportRowThanks(): React.JSX.Element {
  const t = useTranslate()
  // Match the sm button’s dimensions so confirmation cannot change row height.
  return (
    <div
      className="shrink-0 inline-flex h-8 items-center gap-1.5 px-3 text-sm font-medium
        text-amber-400/90 animate-in fade-in slide-in-from-right-1 duration-300"
      role="status"
      aria-live="polite"
    >
      <Star className="size-3.5 fill-amber-400/80 text-amber-400/80" aria-hidden="true" />
      {t('auto.components.settings.GeneralSupportSection.af7d9f4396', 'Thanks for the support!')}
    </div>
  )
}
