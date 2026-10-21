import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsRow } from './SettingsFormControls'

/** Shared by the Clear row and its confirm dialog so both promise the same thing. */
export function sessionSearchClearDescription(enabled: boolean): string {
  return enabled
    ? translate(
        'sessionHistory.settings.deleteEnabled',
        'Turns off search and removes the searchable copy from this computer. Your agent sessions are not affected.'
      )
    : translate(
        'sessionHistory.settings.deleteDisabled',
        'Removes the searchable copy from this computer. Your agent sessions are not affected.'
      )
}

/**
 * Clearing this computer's index, behind Advanced because it is the one action
 * here that destroys something.
 */
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
        title: translate(
          'sessionHistory.settings.deleteTitle',
          'Clear search data on this computer?'
        ),
        description: sessionSearchClearDescription(wasEnabled),
        confirmLabel: translate('sessionHistory.settings.delete', 'Clear'),
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
            ? translate(
                'sessionHistory.settings.clearedAndTurnedOff',
                'Search turned off and search data cleared.'
              )
            : translate('sessionHistory.settings.cleared', 'Search data cleared.')
        )
      }
    } catch {
      if (mounted.current) {
        onError(
          translate('sessionHistory.settings.clearError', 'Could not clear search data. Try again.')
        )
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <div className="border-t border-border">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="xs">
            {translate('sessionHistory.settings.advanced', 'Advanced')}
            <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SettingsRow
            label={translate('sessionHistory.settings.deleteIndexCopy', 'Clear search data')}
            description={sessionSearchClearDescription(enabled)}
            control={
              <Button
                variant="outline"
                size="sm"
                disabled={busy || disabled}
                onClick={() => void clearIndex()}
              >
                {translate('sessionHistory.settings.delete', 'Clear')}
              </Button>
            }
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
