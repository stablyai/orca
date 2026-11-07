import { useRef, useState } from 'react'
import { ArrowLeft, ChevronDown, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { i18n, translate, loadRendererUiLanguage } from '@/i18n/i18n'
import { getUiLanguageNativeLabel } from '@/i18n/supported-languages'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { track } from '@/lib/telemetry'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import {
  SUPPORTED_UI_LOCALES,
  type SupportedUiLocale,
  getRendererLanguageDetection,
  shouldShowLanguageSwitcher
} from '../../../../shared/ui-locale'

export function OnboardingLanguageSwitcher({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element | null {
  const cohort = useAppStore((state) => state.settings?.telemetry?.onboardingLanguageCohort)
  const language = useAppStore((state) => state.settings?.uiLanguage ?? 'system')
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const catalogError = useLanguageReadiness((state) => state.error)
  const catalogLoading = useLanguageReadiness((state) => state.loading)
  const detection =
    useLanguageReadiness((state) => state.detection) ?? getRendererLanguageDetection()
  const [recoveryVisible] = useState(catalogError)
  const [requestView, setRequestView] = useState(false)
  const [draft, setDraft] = useState('')
  const [requestState, setRequestState] = useState<'idle' | 'pending' | 'error' | 'success'>('idle')
  const [selectionPhase, setSelectionPhase] = useState<'load' | 'save' | null>(null)
  const [selectionFailure, setSelectionFailure] = useState<{
    language: SupportedUiLocale
    stage: 'load' | 'save'
  } | null>(null)
  const selectionInFlight = useRef(false)
  const requestInFlight = useRef(false)
  const successfulRequests = useRef(new Set<string>())
  const contentRef = useRef<HTMLDivElement>(null)
  const busy = selectionPhase !== null || catalogLoading
  const canRequestLanguage = !isWebClientLocation()
  const metadata = {
    system_language: detection.detectedTag,
    system_language_supported: detection.status === 'supported',
    detection_source: detection.source,
    effective_language: i18n.language
  }
  const setOpen = (next: boolean): void => {
    if (next) {
      setRequestView(false)
      track('onboarding_language_picker_opened', metadata)
    }
    onOpenChange(next)
  }

  const chooseLanguage = async (next: SupportedUiLocale): Promise<void> => {
    if (selectionInFlight.current || catalogLoading) {
      return
    }
    selectionInFlight.current = true
    setSelectionPhase('load')
    setSelectionFailure(null)
    let stage: 'load' | 'save' = 'load'
    try {
      const locale = await loadRendererUiLanguage(next)
      stage = 'save'
      setSelectionPhase('save')
      await updateSettings({ uiLanguage: next })
      if (useAppStore.getState().settings?.uiLanguage !== next) {
        return
      }
      if (catalogError && language === next) {
        useLanguageReadiness.getState().retryLanguageLoad()
      }
      track('onboarding_language_changed', {
        ...metadata,
        selected_language: next,
        effective_language: locale
      })
    } catch {
      setSelectionFailure({ language: next, stage })
    } finally {
      selectionInFlight.current = false
      setSelectionPhase(null)
    }
  }

  const submitRequest = async (): Promise<void> => {
    const request = draft.trim()
    if (!canRequestLanguage || !request || request.length > 80 || requestInFlight.current) {
      return
    }
    const normalized = request.normalize('NFKC').toLowerCase()
    if (successfulRequests.current.has(normalized)) {
      setRequestState('success')
      return
    }
    requestInFlight.current = true
    setRequestState('pending')
    try {
      const result = await window.api.feedback.submit({
        feedback: `Language request: ${request}`,
        submitAnonymously: true,
        githubLogin: null,
        githubEmail: null
      })
      if (!result.ok) {
        throw new Error(result.error)
      }
      successfulRequests.current.add(normalized)
      setRequestState('success')
      track('onboarding_language_requested', metadata)
    } catch {
      setRequestState('error')
    } finally {
      requestInFlight.current = false
    }
  }

  if (
    cohort === 'control' ||
    (!open && !shouldShowLanguageSwitcher(detection) && !catalogError && !recoveryVisible)
  ) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="shrink-0" lang="en">
          <Globe />
          <span>Switch language</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="end"
        aria-label={translate('onboarding.language.title', 'Display language')}
        className="z-[110] w-80 max-w-[calc(100vw-2rem)]"
        wheelScroll
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const content = contentRef.current
          const selected =
            content?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]') ??
            content?.querySelector<HTMLElement>('[role="radio"]')
          selected?.focus()
        }}
      >
        <div className="scrollbar-sleek max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-4">
          {requestView ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submitRequest()
              }}
            >
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => {
                  setRequestView(false)
                  requestAnimationFrame(() =>
                    contentRef.current
                      ?.querySelector<HTMLElement>('[role="radio"][data-state="checked"]')
                      ?.focus()
                  )
                }}
              >
                <ArrowLeft />
                {translate('onboarding.language.back', 'Languages')}
              </Button>
              <Label htmlFor="onboarding-language-request">
                {translate(
                  'onboarding.language.requestPrompt',
                  'Which language would you like Orca to support?'
                )}
              </Label>
              <Input
                id="onboarding-language-request"
                autoFocus
                maxLength={80}
                value={draft}
                disabled={busy || requestState === 'pending'}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setRequestState('idle')
                }}
              />
              {requestState === 'success' ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {translate(
                    'onboarding.language.requestSuccess',
                    'Language request recorded. You can continue onboarding.'
                  )}
                </p>
              ) : (
                <>
                  {requestState === 'error' && (
                    <p role="alert" className="text-xs text-destructive">
                      {translate(
                        'onboarding.language.requestError',
                        'Could not record your request. Try again.'
                      )}
                    </p>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      !draft.trim() || draft.trim().length > 80 || requestState === 'pending'
                    }
                  >
                    {requestState === 'error'
                      ? translate('onboarding.language.retry', 'Retry')
                      : translate('onboarding.language.requestAction', 'Request language')}
                  </Button>
                </>
              )}
            </form>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  {translate('onboarding.language.title', 'Display language')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {detection.status === 'supported'
                    ? translate('onboarding.language.device', 'System language: {{language}}', {
                        language: getUiLanguageNativeLabel(detection.locale)
                      })
                    : detection.status === 'unsupported'
                      ? translate(
                          'onboarding.language.unsupported',
                          'System language: {{language}}. This language is not supported yet.',
                          { language: detection.detectedTag }
                        )
                      : translate(
                          'onboarding.language.unknown',
                          'Your system language could not be detected. Choose a language below.'
                        )}
                </p>
              </div>
              <RadioGroup
                value={language === 'system' ? detection.locale : language}
                aria-busy={busy}
                aria-disabled={busy}
                onKeyDownCapture={(event) => {
                  if (
                    busy &&
                    [
                      'ArrowDown',
                      'ArrowUp',
                      'ArrowLeft',
                      'ArrowRight',
                      'Home',
                      'End',
                      ' ',
                      'Enter'
                    ].includes(event.key)
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
                onValueChange={(value) => {
                  const locale = SUPPORTED_UI_LOCALES.find((entry) => entry === value)
                  if (locale) {
                    void chooseLanguage(locale)
                  }
                }}
                aria-label={translate('onboarding.language.title', 'Display language')}
              >
                {SUPPORTED_UI_LOCALES.map((locale) => (
                  <div key={locale} className="rounded-md px-2 py-2 hover:bg-accent">
                    <Label className="cursor-pointer">
                      <RadioGroupItem
                        value={locale}
                        onClick={() => {
                          if (language === 'system' && locale === detection.locale) {
                            void chooseLanguage(locale)
                          }
                        }}
                      />
                      <span>{getUiLanguageNativeLabel(locale)}</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <p role="status" className="h-4 text-xs text-muted-foreground">
                {selectionPhase === 'save'
                  ? translate('onboarding.language.saving', 'Saving language…')
                  : busy
                    ? translate('onboarding.language.loading', 'Loading language…')
                    : null}
              </p>
              {(selectionFailure !== null || catalogError) && (
                <div role="alert" className="space-y-2">
                  <p className="text-xs text-destructive">
                    {selectionFailure?.stage === 'save'
                      ? translate(
                          'onboarding.language.saveError',
                          'Could not save your language preference. Try again.'
                        )
                      : translate(
                          'onboarding.language.loadError',
                          'Could not load this language. Try again.'
                        )}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (selectionFailure) {
                        void chooseLanguage(selectionFailure.language)
                      } else {
                        useLanguageReadiness.getState().retryLanguageLoad()
                      }
                    }}
                  >
                    {translate('onboarding.language.retry', 'Retry')}
                  </Button>
                </div>
              )}
              {canRequestLanguage && (
                <div className="border-t border-border pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    disabled={busy}
                    onClick={() => setRequestView(true)}
                  >
                    {translate('onboarding.language.other', 'Other language…')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
