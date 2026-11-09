import React, { useCallback, useState } from 'react'
import { Share2 } from 'lucide-react'
import { toast } from 'sonner'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  isCloudSharesAvailable,
  useCloudShares,
  type CloudSharesController
} from '@/lib/cloud-shares/cloud-shares-store'
import { useAppStore } from '@/store'
import {
  SHARE_RESERVED_PORTS,
  type CloudShareFailureCode,
  type ShareLink
} from '../../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import { shareErrorMessage } from './share-link-status'
import { SharePortDialog } from './share-port-dialog'

const MENU_ITEM_CLASS =
  'rounded-md focus:bg-accent focus:text-accent-foreground dark:focus:bg-accent'

/** "Sign in" on a toast when the failure is a signed-out Orca account. */
function signInAction(code: CloudShareFailureCode): {
  action?: { label: string; onClick: () => void }
} {
  if (code !== 'unauthorized') {
    return {}
  }
  return {
    action: {
      label: translate('auto.components.right.sidebar.CloudShare.signIn', 'Sign in to Orca'),
      onClick: () => void useAppStore.getState().connectCurrentOrcaProfile()
    }
  }
}

export type SharePortAction = {
  /** False until the environment is known to be Orca Cloud: callers hide every share affordance. */
  available: boolean
  controller: CloudSharesController
  openShareDialog: (port: number | null, detectedPorts?: readonly number[]) => void
  /** Render once wherever the action is used. */
  dialog: React.ReactNode
  copy: (url: string) => Promise<boolean>
  open: (share: ShareLink) => void
  revoke: (share: ShareLink) => Promise<boolean>
}

const NO_PORTS: readonly number[] = []

export function useSharePortAction(environmentId: string | null): SharePortAction {
  const controller = useCloudShares(environmentId)
  const [dialog, setDialog] = useState<{
    port: number | null
    detectedPorts: readonly number[]
    key: number
    open: boolean
  }>({ port: null, detectedPorts: NO_PORTS, key: 0, open: false })

  const copy = useCallback(async (url: string) => {
    try {
      await window.api.ui.writeClipboardText(url)
      return true
    } catch {
      toast.error(
        translate('auto.components.right.sidebar.CloudShare.copyFailed', 'Couldn’t copy the link.')
      )
      return false
    }
  }, [])
  const { open: openLink, revoke: revokeLink } = controller
  const open = useCallback(
    (share: ShareLink) => {
      void openLink(share.id).then((result) => {
        if (!result.ok) {
          toast.error(shareErrorMessage(result.code), signInAction(result.code))
        }
      })
    },
    [openLink]
  )
  const revoke = useCallback(
    async (share: ShareLink) => {
      // The row keeps its confirm open and says it failed; only a sign-out needs more than that.
      const result = await revokeLink(share.id)
      if (!result.ok && result.code === 'unauthorized') {
        toast.error(shareErrorMessage(result.code), signInAction(result.code))
      }
      return result.ok
    },
    [revokeLink]
  )
  const openShareDialog = useCallback(
    (port: number | null, detectedPorts: readonly number[] = NO_PORTS) => {
      // A new key mounts a fresh form, so nothing (an earlier wake opt-in) carries over.
      setDialog((current) => ({ port, detectedPorts, key: current.key + 1, open: true }))
    },
    []
  )
  const setOpen = useCallback((open: boolean) => setDialog((current) => ({ ...current, open })), [])

  return {
    available: isCloudSharesAvailable(controller.state),
    controller,
    openShareDialog,
    dialog: (
      <SharePortDialog
        key={dialog.key}
        open={dialog.open}
        onOpenChange={setOpen}
        port={dialog.port}
        detectedPorts={dialog.detectedPorts}
        shares={controller.state.shares}
        onCreate={controller.create}
        onCopy={copy}
        onOpen={open}
        onRevoke={revoke}
      />
    ),
    copy,
    open,
    revoke
  }
}

/** "Share…" for a port row's context menu (cloud workspaces only). */
export function SharePortMenuItem({
  port,
  action
}: {
  port: number
  action: Pick<SharePortAction, 'available' | 'openShareDialog'>
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!action.available || SHARE_RESERVED_PORTS.includes(port)) {
    return null
  }
  return (
    <ContextMenuItem className={MENU_ITEM_CLASS} onSelect={() => action.openShareDialog(port)}>
      <Share2 size={13} />
      {t('auto.components.right.sidebar.CloudShare.menuShare', 'Share…')}
    </ContextMenuItem>
  )
}
