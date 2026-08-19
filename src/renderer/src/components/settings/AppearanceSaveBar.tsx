import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type AppearanceSaveBarProps = {
  changeCount: number
  saving: boolean
  saveFailed: boolean
  onSave: () => Promise<unknown>
  onDiscard: () => void
}

export function AppearanceSaveBar({
  changeCount,
  saving,
  saveFailed,
  onSave,
  onDiscard
}: AppearanceSaveBarProps): React.JSX.Element | null {
  const [showSaving, setShowSaving] = useState(false)

  useEffect(() => {
    if (!saving) {
      setShowSaving(false)
      return
    }
    const timer = window.setTimeout(() => setShowSaving(true), 750)
    return () => window.clearTimeout(timer)
  }, [saving])

  if (changeCount === 0 && !saveFailed) {
    return null
  }

  const changeLabel =
    changeCount === 1
      ? translate('auto.components.settings.AppearanceSaveBar.singleChange', '1 unsaved change')
      : translate(
          'auto.components.settings.AppearanceSaveBar.multipleChanges',
          '{{value0}} unsaved changes',
          { value0: changeCount }
        )

  return (
    <div className="sticky top-4 z-10 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
      <div className="min-w-0" aria-live="polite">
        <p className="text-sm font-medium text-card-foreground">{changeLabel}</p>
        {saveFailed ? (
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.settings.AppearanceSaveBar.saveFailed',
              'Appearance settings could not be saved. Try again.'
            )}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
          {translate('auto.components.settings.AppearanceSaveBar.discard', 'Discard')}
        </Button>
        <Button
          type="button"
          size="sm"
          className="w-24"
          disabled={saving || changeCount === 0}
          onClick={() => void onSave().catch(() => undefined)}
        >
          {showSaving ? <Loader2 className="size-4 animate-spin" /> : null}
          {showSaving
            ? translate('auto.components.settings.AppearanceSaveBar.saving', 'Saving…')
            : translate('auto.components.settings.AppearanceSaveBar.save', 'Save')}
        </Button>
      </div>
    </div>
  )
}
