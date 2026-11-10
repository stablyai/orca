import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { addOnThisComputerLabel } from '@/lib/workspace/creation/wsl-host-windows-drive-refusal-toast'
import { useAppStore } from '@/store/index'
import type { AddRepoExistingWorkspaceSource } from '../../../../../../shared/telemetry-events'
import { addWslHostDistro } from '../../host-admission/wsl/add-wsl-host-distro'
import { wslHostAddRefusalMessage } from '../../wsl-host-failure-text'
import {
  acceptWslHostOffer,
  declineWslHostOffer,
  type WslHostOffer
} from '../../wsl-host-offer-actions'
import { moveWslHostOfferProject } from '../../wsl-host-offer-move'

/** Inline in the add-project flow: run the `\\wsl.localhost` path's distro as a host instead. */
export function AddRepoWslHostOffer({
  offer,
  onSettled,
  addLocalPath
}: {
  offer: WslHostOffer
  onSettled: () => void
  addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { distro } = offer

  const accept = async (): Promise<void> => {
    setBusy('accept')
    setError(null)
    try {
      const refusal = await acceptWslHostOffer(offer, {
        readWslHostsSetting: () => useAppStore.getState().settings?.experimentalWslHosts === true,
        updateSettings: (updates) => useAppStore.getState().updateSettingsOrThrow(updates),
        addWslHost: addWslHostDistro,
        addLocalPath: (path, source) => {
          onSettled()
          return addLocalPath(path, source)
        },
        moveAddedProject: moveWslHostOfferProject
      })
      if (refusal) {
        setError(wslHostAddRefusalMessage(refusal))
      }
    } catch (cause) {
      setError(readIpcErrorDetail(cause) ?? String(cause))
    } finally {
      setBusy(null)
    }
  }

  const decline = (): void => {
    setBusy('decline')
    void declineWslHostOffer(offer, {
      updateSettings: (updates) => useAppStore.getState().updateSettings(updates),
      addLocalPath: (path, source) => {
        onSettled()
        return addLocalPath(path, source)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium">
        {t('sidebar.wslHostOffer.title', 'Run {{distro}} as a host (recommended)', {
          distro
        })}
      </p>
      <p className="text-2xs text-muted-foreground">
        {t(
          'sidebar.wslHostOffer.why',
          'Git, files and terminals then run natively in Linux instead of across the Windows file share.'
        )}
      </p>
      {busy === 'accept' ? (
        <p className="text-2xs text-muted-foreground" aria-live="polite">
          {t(
            'auto.components.sidebar.AddWslHostFormPanel.addingHint',
            'Installing and starting the Orca server in the distro. The first time can take a minute.'
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void accept()} disabled={busy !== null}>
          {busy === 'accept' ? <LoadingSpinner className="size-4" /> : null}
          {busy === 'accept'
            ? t('auto.components.sidebar.AddWslHostFormPanel.adding', 'Setting up…')
            : t('sidebar.wslHostOffer.accept', 'Run as host')}
        </Button>
        <Button size="sm" variant="secondary" onClick={decline} disabled={busy !== null}>
          {addOnThisComputerLabel(t)}
        </Button>
      </div>
    </div>
  )
}
