import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SettingsRow } from '../form-controls/SettingsFormControls'

/** Shared by the Clear row and its confirm dialog so both promise the same thing. */
export function sessionSearchClearDescription(enabled: boolean, t: Translate = translate): string {
  return enabled
    ? t(
        'sessionHistory.settings.deleteEnabled',
        'Turns off search and removes the searchable copy from this computer. Your agent sessions are not affected.'
      )
    : t(
        'sessionHistory.settings.deleteDisabled',
        'Removes the searchable copy from this computer. Your agent sessions are not affected.'
      )
}

/** Hide destructive index clearing under Advanced. */
export function SessionSearchAdvancedSection({
  enabled,
  disabled,
  turnSearchOff,
  onError,
  onCleared
}: {
  enabled: boolean
  disabled: boolean
  /** Returns false when the write failed or the pane went away, so the delete is skipped. */
  turnSearchOff: () => Promise<boolean>
  onError: (message: string | null) => void
  onCleared: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const mounted = useMountedRef()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function clearIndex(): Promise<void> {
    const wasEnabled = enabled
    setBusy(true)
    onError(null)
    try {
      const accepted = await confirm({
        title: t('sessionHistory.settings.deleteTitle', 'Clear search data on this computer?'),
        description: sessionSearchClearDescription(wasEnabled),
        confirmLabel: t('sessionHistory.settings.delete', 'Clear'),
        confirmVariant: 'destructive'
      })
      if (!accepted || !mounted.current) {
        return
      }
      // Clearing while search is on makes the host rebuild the index immediately; turn it off first.
      if (wasEnabled && !(await turnSearchOff())) {
        return
      }
      await window.api.aiVault.clearSearchIndex()
      if (mounted.current) {
        onCleared()
        toast.success(
          wasEnabled
            ? t(
                'sessionHistory.settings.clearedAndTurnedOff',
                'Search turned off and search data cleared.'
              )
            : t('sessionHistory.settings.cleared', 'Search data cleared.')
        )
      }
    } catch {
      if (mounted.current) {
        onError(t('sessionHistory.settings.clearError', 'Could not clear search data. Try again.'))
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div data-settings-row="" className="py-2">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="xs">
            {t('sessionHistory.settings.advanced', 'Advanced')}
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SettingsRow
            label={t('sessionHistory.settings.deleteIndexCopy', 'Clear search data')}
            description={sessionSearchClearDescription(enabled, t)}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={busy || disabled}
                onClick={() => void clearIndex()}
              >
                {t('sessionHistory.settings.delete', 'Clear')}
              </Button>
            }
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
