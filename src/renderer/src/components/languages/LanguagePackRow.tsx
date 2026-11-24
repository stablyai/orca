import { useId } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { isUsablePluginLanguagePack } from '../../../../shared/plugins/languages/plugin-language-pack-coverage'

export type LanguageRowModel = {
  id: string
  /** Shown in its own language, e.g. "italiano". */
  name: string
  nameLang?: string
  /** Muted companion on the same line: the English name, or the language System resolves to. */
  hint?: string
  hintLang?: string
  /** Shown only to tell two packs for one language apart. */
  publisher?: string
  /** Shown only when below the usable threshold. */
  coverage?: number
  selected: boolean
  /** Matches the device language; adds a muted "your device" gloss. */
  device?: boolean
  /** A catalog pack that must be installed (via the trust dialog) before it can be used. */
  needsInstall?: boolean
  busy?: boolean
  /** For a pack being installed: reading it before consent, or installing after it. */
  installPhase?: 'preparing' | 'installing'
  /** Interaction blocked, e.g. while another change is in flight. */
  disabled?: boolean
  /** Cannot be used right now (plugins turned off); the notice above the list explains why. */
  unavailable?: boolean
  /** The saved language whose catalog failed to load. */
  failed?: boolean
  /** What Orca shows while the saved language failed: checked, but still selectable to keep it. */
  effective?: boolean
  /** What the picker focuses when it opens. */
  autoFocusTarget?: boolean
  error?: string
  onSelect: () => void
}

/** One line per language: name, muted gloss, and a quiet trailing state. */
export function LanguagePackRow({ row }: { row: LanguageRowModel }): React.JSX.Element {
  const t = useTranslate()
  const errorId = useId()
  const incomplete =
    row.coverage !== undefined && !isUsablePluginLanguagePack({ coverage: row.coverage })
  // Why aria-disabled, not disabled: the current row and unusable rows stay focusable and announced.
  const blocked = row.disabled || row.busy || row.selected || incomplete || row.unavailable
  const gloss = [
    row.hint ? { text: row.hint, lang: row.hintLang } : null,
    row.publisher
      ? { text: t('languages.byPublisher', 'by {{publisher}}', { publisher: row.publisher }) }
      : null,
    incomplete
      ? { text: t('languages.coverage', '{{percent}}% translated', { percent: row.coverage }) }
      : null,
    row.device ? { text: t('languages.deviceTag', 'your device') } : null
  ].filter((part): part is { text: string; lang?: string } => part !== null)
  return (
    <li>
      <button
        type="button"
        data-scroll-anchor={row.selected || row.failed ? '' : undefined}
        data-picker-autofocus={row.autoFocusTarget ? '' : undefined}
        aria-current={row.selected ? 'true' : undefined}
        aria-busy={row.busy || undefined}
        aria-disabled={blocked || undefined}
        aria-describedby={row.error ? errorId : undefined}
        onClick={blocked ? undefined : row.onSelect}
        className={cn(
          'flex min-h-9 w-full items-center gap-3 rounded-md px-3 py-1.5 text-left outline-none transition-colors',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          row.selected ? 'bg-accent/50' : blocked ? 'cursor-default' : 'hover:bg-accent/60'
        )}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={cn(
              'shrink-0 truncate text-sm font-medium text-foreground',
              incomplete && 'opacity-55'
            )}
            lang={row.nameLang}
          >
            {row.name}
          </span>
          {gloss.length > 0 && (
            <span className="truncate text-[13px] text-muted-foreground">
              {gloss.map((part, index) => (
                <span key={part.text} lang={part.lang}>
                  {index > 0 && ' · '}
                  {part.text}
                </span>
              ))}
            </span>
          )}
        </span>
        <RowTrailing row={row} incomplete={incomplete} />
      </button>
      {row.error && (
        <p id={errorId} role="alert" className="px-3 pb-1.5 text-xs text-destructive">
          {row.error}
        </p>
      )}
    </li>
  )
}

function RowTrailing({
  row,
  incomplete
}: {
  row: LanguageRowModel
  incomplete: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const muted = 'flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground'
  if (row.busy) {
    return (
      <span className={muted}>
        <LoadingSpinner className="size-3.5" />
        {row.installPhase === 'installing' ? (
          t('languages.installing', 'Installing…')
        ) : row.installPhase === 'preparing' ? (
          t('languages.preparing', 'Preparing…')
        ) : (
          <span className="sr-only">{t('languages.changing', 'Changing…')}</span>
        )}
      </span>
    )
  }
  if (row.failed || (row.error && !row.needsInstall)) {
    return (
      <span className="flex shrink-0 items-center text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {row.failed && <span className="sr-only">{t('languages.didNotLoad', 'Didn’t load')}</span>}
      </span>
    )
  }
  if (row.selected || row.effective) {
    return (
      <span className="flex shrink-0 items-center text-foreground">
        <Check className="size-4" aria-hidden="true" />
        <span className="sr-only">{t('languages.current', 'Current')}</span>
      </span>
    )
  }
  if (incomplete) {
    return <span className={muted}>{t('languages.incomplete', 'Incomplete')}</span>
  }
  if (row.needsInstall && !row.unavailable) {
    return (
      <span className={muted}>
        {row.error ? t('languages.retry', 'Retry') : t('languages.get', 'Get')}
      </span>
    )
  }
  return null
}
