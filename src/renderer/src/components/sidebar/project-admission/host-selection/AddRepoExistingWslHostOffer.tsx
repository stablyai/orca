import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import { addOnThisComputerLabel } from '@/lib/wsl-host-windows-drive-refusal-toast'

/** Inline in the add-project flow: the `\\wsl.localhost` path's distro already runs as a host. */
export function AddRepoExistingWslHostOffer({
  distro,
  onAddOnHost,
  onAddOnThisComputer
}: {
  distro: string
  onAddOnHost: () => Promise<void>
  onAddOnThisComputer: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const addOnHost = (): void => {
    setBusy(true)
    void onAddOnHost().finally(() => setBusy(false))
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium">
        {translate(
          'sidebar.wslHostOffer.existingTitle',
          'Add on the {{distro}} host (recommended)',
          { distro }
        )}
      </p>
      <p className="text-2xs text-muted-foreground">
        {translate(
          'sidebar.wslHostOffer.existingWhy',
          '{{distro}} already runs as a host, so Git, files and terminals run natively in Linux instead of across the Windows file share.',
          { distro }
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={addOnHost} disabled={busy}>
          {busy ? <LoadingSpinner className="size-4" /> : null}
          {translate('sidebar.wslHostOffer.existingAccept', 'Add on host')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onAddOnThisComputer} disabled={busy}>
          {addOnThisComputerLabel()}
        </Button>
      </div>
    </div>
  )
}
