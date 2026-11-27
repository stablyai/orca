import { useCallback, useEffect, useRef, useState } from 'react'
import { Laptop } from 'lucide-react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { RuntimeAccessGrant } from '../../../../../../shared/remote-runtime/host-catalog/runtime-access-grants'
import { Button } from '../../../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../../../ui/dialog'
import { MachineNameField } from '../../../machine-identity/MachineNameField'
import { RuntimePairingUrlGenerator } from './RuntimePairingUrlGenerator'
import { usePublishedMachineName } from '../../../machine-identity/use-published-machine-name'
import { runtimePairingLinkCache } from './runtime-pairing-link-state'

/** Desktop only: the block under the server list that lets other devices pair with this computer. */
export function RuntimeShareComputerSection(): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [runtimeAccessGrants, setRuntimeAccessGrants] = useState<RuntimeAccessGrant[] | null>()
  const mountedRef = useMountedRef()
  const accessGrantRequest = useRef(0)
  const machineName = useAppStore((state) => state.settings?.machineName ?? '')
  const publishedMachineName = usePublishedMachineName(machineName)

  const loadRuntimeAccessGrants = useCallback(async () => {
    const request = ++accessGrantRequest.current
    const { runtimePairingDeviceId } = runtimePairingLinkCache
    const result = await window.api.mobile.listRuntimeAccessGrants().catch(() => null)
    if (mountedRef.current && request === accessGrantRequest.current) {
      if (
        result &&
        runtimePairingDeviceId !== null &&
        runtimePairingDeviceId === runtimePairingLinkCache.runtimePairingDeviceId
      ) {
        const generatedGrant = result.grants.find(
          (grant) => grant.deviceId === runtimePairingDeviceId
        )
        runtimePairingLinkCache.grantStatus = !generatedGrant
          ? 'removed'
          : generatedGrant.lastSeenAt === null
            ? 'unused'
            : 'used'
      }
      setRuntimeAccessGrants(result?.grants ?? null)
    }
  }, [mountedRef])
  useEffect(() => {
    const refresh = (): void => void loadRuntimeAccessGrants()
    const unsubscribe = window.api.mobile.onDevicesChanged(refresh)
    window.addEventListener('focus', refresh)
    refresh()
    return () => {
      accessGrantRequest.current += 1
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [loadRuntimeAccessGrants])

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      setEditingName(false)
    }
    void loadRuntimeAccessGrants()
  }

  const handleAccessGrantRevoked = (deviceId: string): void => {
    if (!mountedRef.current) {
      return
    }
    setRuntimeAccessGrants(
      (current) => current?.filter((grant) => grant.deviceId !== deviceId) ?? current
    )
    void loadRuntimeAccessGrants()
  }

  const activeLinkCount = runtimeAccessGrants?.length ?? null
  const activeLinksLabel = !activeLinkCount
    ? null
    : activeLinkCount === 1
      ? t('auto.components.settings.serverList.oneActiveLink', '1 active link')
      : t('auto.components.settings.serverList.activeLinks', '{{value0}} active links', {
          value0: activeLinkCount
        })

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div data-settings-section="share-computer" className="scroll-mt-8 space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('auto.components.settings.serverList.thisComputer', 'This computer')}
        </h3>
        <div className="flex min-h-14 items-center gap-2 rounded-lg border border-border bg-card px-4 py-2.5">
          <Laptop aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {activeLinksLabel ??
                (activeLinkCount === 0
                  ? t(
                      'auto.components.settings.serverList.shareRowHint',
                      'Let another Orca connect here.'
                    )
                  : null)}
            </div>
          </div>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="xs">
              {activeLinksLabel
                ? t('auto.components.settings.serverList.manageShare', 'Manage')
                : t('auto.components.settings.serverList.share', 'Share')}
            </Button>
          </DialogTrigger>
        </div>
      </div>
      <DialogContent className="sm:max-w-xl" scrollable>
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.settings.serverList.shareTitle', 'Share this computer')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.settings.serverList.shareDialogDescriptionRuns',
              'Anyone with the link can run commands as you on this computer until you revoke it.'
            )}
          </DialogDescription>
        </DialogHeader>
        {activeLinksLabel ? (
          <p className="text-xs text-muted-foreground">{activeLinksLabel}</p>
        ) : null}
        <RuntimePairingUrlGenerator
          framed={false}
          showHeader={false}
          runtimeAccessGrants={runtimeAccessGrants ?? null}
          loadRuntimeAccessGrants={loadRuntimeAccessGrants}
          onAccessGrantRevoked={handleAccessGrantRevoked}
        />
        {runtimeAccessGrants === null ? (
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-xs text-muted-foreground">
              {t(
                'auto.components.settings.RuntimePairingUrlGenerator.1b4e0bbcc5',
                'Failed to load shared access grants.'
              )}
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                setRuntimeAccessGrants(undefined)
                void loadRuntimeAccessGrants()
              }}
            >
              {t('auto.components.settings.serverList.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        {editingName ? (
          <MachineNameField id="runtime-share-machine-name" />
        ) : (
          <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {t('auto.components.settings.serverList.shownAs', 'Shown to others as {{name}}', {
                name:
                  publishedMachineName ??
                  t('auto.components.settings.serverList.thisComputer', 'This computer')
              })}
            </span>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => setEditingName(true)}
            >
              {t('auto.components.settings.serverList.editName', 'Edit')}
            </button>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            {t('auto.components.settings.serverList.done', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
