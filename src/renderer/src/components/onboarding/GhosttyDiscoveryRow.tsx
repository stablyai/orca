import { Check } from 'lucide-react'
import type { GhosttyImportPreview } from '../../../../shared/types'
import ghosttyIcon from '../../../../../resources/ghostty.svg'
import { translate } from '@/i18n/i18n'
import type { DiscoveryState } from './ThemeStep'

export function GhosttyDiscoveryRow({
  discovery,
  importing,
  disabled,
  onImport
}: {
  discovery: DiscoveryState
  importing: boolean
  disabled: boolean
  onImport: (preview: GhosttyImportPreview) => void
}) {
  // Why: 'idle' is the pre-effect state that persists on non-Mac (the
  // discovery effect short-circuits there), so render nothing instead of
  // showing the dashed-border "Looking for a Ghostty config..." placeholder.
  if (discovery.status === 'absent' || discovery.status === 'idle') {
    return null
  }

  if (discovery.status === 'detecting') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-border bg-transparent px-3.5 py-2.5 text-[12px] text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
        {translate(
          'auto.components.onboarding.ThemeStep.2c3aa538f8',
          'Looking for a Ghostty config...'
        )}
      </div>
    )
  }

  if (discovery.status === 'imported') {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.07] px-3.5 py-2.5 text-[12px] text-foreground">
        <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
        <span className="flex-1">
          <span className="font-medium">
            {translate('auto.components.onboarding.ThemeStep.78b6386140', 'Imported from Ghostty.')}
          </span>
          {discovery.fields.length > 0 && (
            <span className="text-muted-foreground"> {discovery.fields.join(' · ')}</span>
          )}
        </span>
      </div>
    )
  }

  const { preview, fields } = discovery
  return (
    <div className="flex items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3.5 py-2.5">
      <img src={ghosttyIcon} alt="" className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-foreground">
          <span className="font-medium">
            {translate(
              'auto.components.onboarding.ThemeStep.7ee9234e54',
              'Ghostty config detected.'
            )}
          </span>{' '}
          <span className="text-muted-foreground">
            {translate('auto.components.onboarding.ThemeStep.248c812283', 'Import')}{' '}
            {fields.length > 0
              ? fields.map((f) => f.toLowerCase()).join(', ')
              : translate('auto.components.onboarding.ThemeStep.906c4373fe', 'settings')}
            ?
          </span>
        </div>
        {preview.configPath && (
          <div
            className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground"
            title={preview.configPath}
          >
            {preview.configPath}
          </div>
        )}
      </div>
      <button
        className="shrink-0 rounded-md bg-foreground px-3 py-1.5 text-[11.5px] font-semibold text-background hover:bg-foreground/90 disabled:opacity-50"
        disabled={importing || disabled}
        onClick={() => onImport(preview)}
      >
        {importing
          ? translate('auto.components.onboarding.ThemeStep.ad19e5c916', 'Importing...')
          : translate('auto.components.onboarding.ThemeStep.248c812283', 'Import')}
      </button>
    </div>
  )
}
