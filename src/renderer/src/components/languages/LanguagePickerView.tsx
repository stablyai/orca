import { useCallback, useEffect, useRef } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Info,
  MessageSquarePlus,
  Puzzle,
  RotateCw,
  Search
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useScrollEdgeFades } from '@/lib/list-interaction/use-scroll-edge-fades'
import { isLanguageSearchEmpty, LanguageList, type LanguageListProps } from './LanguageList'
import { LANGUAGE_PICKER_FOOTER_CLASS, LanguageRequestForm } from './LanguageRequestForm'

export type LanguagePickerViewProps = LanguageListProps & {
  onboarding: boolean
  onQueryChange: (query: string) => void
  /** Disables the footer; unlike `busy` it stays false while an install is only preparing. */
  footerBusy: boolean
  /** The saved language whose catalog failed to load. */
  failedLanguage: { name: string } | null
  onRetryLanguage: () => void
  /** Errors no row owns, e.g. a failed switch back. Row-scoped errors live on their row. */
  error: string | null
  /** Set while a community translation is active; names the language to return to. */
  switchBackTo: { name: string; lang?: string } | null
  onSwitchBack: () => void
  requesting: boolean
  /** Prefills the request form, e.g. from a search with no matches. */
  requestDraft?: string
  onRequestBack: () => void
  onDone: () => void
}

// Why a nested label: Button owns its color, so the quieter footer tone lives on its content.
const QUIET_LABEL =
  'flex items-center gap-1.5 text-foreground/70 transition-colors group-hover/quiet:text-foreground'

/** The picker dialog's content, props in, so every state renders without the plugin catalog. */
export function LanguagePickerView(props: LanguagePickerViewProps): React.JSX.Element {
  const t = useTranslate()
  const { onboarding, busy, footerBusy, requesting, switchBackTo } = props
  const fades = useScrollEdgeFades<HTMLDivElement>()
  const listRef = useRef<HTMLDivElement | null>(null)
  const setFadesRef = fades.ref
  const setList = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      setFadesRef(node)
    },
    [setFadesRef]
  )
  useEffect(() => {
    // Why scrollTop, not scrollIntoView: scrollIntoView would also scroll the clipped dialog.
    const list = listRef.current
    const anchor = list?.querySelector<HTMLElement>('[data-scroll-anchor]')
    if (list && anchor && anchor.offsetTop + anchor.offsetHeight > list.clientHeight) {
      list.scrollTop = anchor.offsetTop - list.clientHeight / 2
    }
  }, [])
  const searchEmpty = isLanguageSearchEmpty(props)
  const notice = 'flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 px-5 pt-5 pr-12 pb-4">
        <DialogTitle>
          {requesting
            ? t('languages.request', 'Request a language')
            : t('onboarding.language.title', 'Display language')}
        </DialogTitle>
        <DialogDescription>
          {requesting
            ? t(
                'languages.requestDescription',
                'Tell us which language to add. Anyone can also publish a community translation.'
              )
            : t(
                'languages.description',
                'Built-in languages and community translations. Untranslated text stays in English.'
              )}
        </DialogDescription>
      </div>
      {requesting ? (
        <LanguageRequestForm
          onboarding={onboarding}
          initialDraft={props.requestDraft}
          onBack={props.onRequestBack}
          onDone={props.onDone}
        />
      ) : (
        <>
          <div className="flex flex-col gap-3 px-5 pb-2">
            {/* Why a drawn field: the leading icon sits inside the field, so the input is the embedded text run. */}
            <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background/60 px-3 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 dark:bg-input/30">
              <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <Input
                surface="embedded"
                value={props.query}
                onChange={(event) => props.onQueryChange(event.target.value)}
                // Why a marker: the dialog focuses this on open however it was opened.
                data-picker-autofocus={props.pinned ? undefined : ''}
                aria-label={t('languages.search', 'Search languages')}
                placeholder={t('languages.searchPlaceholder', 'Search languages')}
              />
            </div>
            {props.pluginsDisabled && (
              <p className={notice}>
                <Info aria-hidden="true" className="size-3.5 shrink-0" />
                {props.community.length > 0
                  ? t(
                      'languages.pluginsDisabledCount',
                      '{{count}} community translations need plugins turned on.',
                      {
                        count: props.community.length,
                        defaultValue_one: '{{count}} community translation needs plugins turned on.'
                      }
                    )
                  : t(
                      'languages.pluginsDisabled',
                      'Community translations need plugins turned on.'
                    )}
                {props.onManagePlugins && (
                  <Button
                    size="xs"
                    variant="link"
                    className="-ml-1"
                    onClick={props.onManagePlugins}
                  >
                    {t('languages.turnOnPlugins', 'Turn on in Plugins')}
                  </Button>
                )}
              </p>
            )}
            {props.failedLanguage && (
              <p role="alert" className={notice}>
                <AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
                {t('languages.languageDidNotLoad', '{{language}} didn’t load.', {
                  language: props.failedLanguage.name
                })}
                <Button
                  size="xs"
                  variant="link"
                  className="-ml-1"
                  disabled={busy}
                  onClick={props.onRetryLanguage}
                >
                  <RotateCw />
                  {t('languages.retry', 'Retry')}
                </Button>
              </p>
            )}
          </div>
          <div
            ref={setList}
            className={cn(
              'scrollbar-sleek relative max-h-[min(56vh,28rem)] min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3',
              fades.className
            )}
            aria-busy={busy}
          >
            <LanguageList {...props} />
          </div>
          {props.error && (
            <p role="alert" className="px-5 pb-2 text-xs text-destructive">
              {props.error}
            </p>
          )}
          <div className={LANGUAGE_PICKER_FOOTER_CLASS}>
            <div className="-ml-2.5 flex min-w-0 items-center">
              {switchBackTo ? (
                // Why English literal: the active community pack may be partial or broken.
                <Button
                  size="sm"
                  variant="ghost"
                  className="group/quiet"
                  lang="en"
                  disabled={footerBusy}
                  onClick={props.onSwitchBack}
                >
                  <span className={QUIET_LABEL}>
                    <ArrowLeft className="size-3.5" />
                    <span>
                      Switch back to <span lang={switchBackTo.lang}>{switchBackTo.name}</span>
                    </span>
                  </span>
                </Button>
              ) : (
                props.onRequest &&
                !searchEmpty && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="group/quiet"
                    disabled={footerBusy}
                    onClick={() => props.onRequest?.()}
                  >
                    <span className={QUIET_LABEL}>
                      <MessageSquarePlus className="size-3.5" />
                      {t('languages.request', 'Request a language')}
                    </span>
                  </Button>
                )
              )}
              {props.onManagePlugins && !searchEmpty && (
                // Why hidden when narrow: an icon-only Plugins link would read as a stray glyph.
                <span className="@max-[28rem]:hidden">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="group/quiet"
                    disabled={footerBusy}
                    onClick={props.onManagePlugins}
                  >
                    <span className={QUIET_LABEL}>
                      <Puzzle className="size-3.5" />
                      {t('languages.managePacks', 'Browse in Plugins')}
                    </span>
                  </Button>
                </span>
              )}
            </div>
            <Button size="sm" variant={onboarding ? 'default' : 'outline'} onClick={props.onDone}>
              {onboarding ? t('languages.continue', 'Continue') : t('languages.done', 'Done')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
