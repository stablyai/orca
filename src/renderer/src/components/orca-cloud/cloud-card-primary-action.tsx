// The cloud card's one visible action (Sleep, Wake, Unarchive or Restart), split from the panel.
import type React from 'react'
import { ArchiveRestore, Loader2, Moon, Play, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { cloudCardPrimary } from './cloud-workspace-card-model'
import type { CloudPanelActions } from './CloudWorkspaceStatusPanel'

type Pending = 'restart' | 'archive' | 'unarchive' | undefined

/** Pending buttons stay focused and announced: aria-disabled + aria-busy, never `disabled`. */
function busyProps(isBusy: boolean, anyBusy: boolean, onClick: () => void) {
  return {
    'aria-disabled': anyBusy || undefined,
    'aria-busy': isBusy || undefined,
    onClick: () => {
      if (!anyBusy) {
        onClick()
      }
    }
  }
}

export function CloudCardPrimaryAction({
  primary,
  pending,
  restarting,
  anyBusy,
  actions
}: {
  primary: ReturnType<typeof cloudCardPrimary>
  pending: Pending
  restarting: boolean
  anyBusy: boolean
  actions: CloudPanelActions
}): React.JSX.Element | null {
  const t = useTranslate()
  switch (primary) {
    case 'sleep':
      return actions.onSleep ? (
        <Button size="xs" variant="outline" {...busyProps(false, anyBusy, actions.onSleep)}>
          <Moon />
          {t('orcaCloudWorkspace.sleep', 'Sleep')}
        </Button>
      ) : null
    case 'wake':
      // PAIRED-CHROME: a paired row has no Wake button yet (PAIRED-WAKE 2/2); opening it wakes it.
      if (!actions.onWake) {
        return (
          <span className="mr-auto text-xs text-muted-foreground" data-cloud-card-wake-hint>
            {t('orcaCloudWorkspace.opensAndWakes', 'Opens and wakes when you select it.')}
          </span>
        )
      }
      return (
        <Button size="xs" {...busyProps(false, anyBusy, actions.onWake)}>
          <Play />
          {t('orcaCloudWorkspace.wake', 'Wake')}
        </Button>
      )
    case 'unarchive':
      return actions.onUnarchive ? (
        <Button size="xs" {...busyProps(pending === 'unarchive', anyBusy, actions.onUnarchive)}>
          {pending === 'unarchive' ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
          {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
        </Button>
      ) : null
    case 'restart':
      return actions.onRestart ? (
        // CLOUD-CARD-RESTARTING-CLICK: "Restarting…" is inert. A restart main runs (rollover, Restart
        // now) leaves anyBusy false, and a click then started a second restart.
        <Button size="xs" {...busyProps(restarting, anyBusy || restarting, actions.onRestart)}>
          {restarting ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {restarting
            ? t('orcaCloudWorkspace.restarting', 'Restarting…')
            : t('orcaCloudWorkspace.restart', 'Restart')}
        </Button>
      ) : null
    case null:
      return null
  }
}
