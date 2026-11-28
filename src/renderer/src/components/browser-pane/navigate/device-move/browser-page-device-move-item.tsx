import { Laptop, Server } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { runtimeHostsPagesOnThisDesktop } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import '../../../../../../shared/remote-runtime/protocol/protocol-version'
import { BROWSER_SCREENCAST_RUNTIME_CAPABILITY } from '../../../../../../shared/browser/runtime/browser-runtime-capabilities'
import {
  moveBrowserPageAcrossDevices,
  resolveBrowserPageMoveUrl,
  type BrowserPageMoveDestination
} from './browser-page-device-move'
import {
  browserPageMoveFailureText,
  browserPageMoveLabel,
  browserPageMoveOutcomeText,
  browserPageMoveTooltip
} from './browser-page-device-move-copy'

export type BrowserPageDeviceMoveTarget = {
  browserPageId: string
  worktreeId: string
  environmentId: string
  url: string
  destination: BrowserPageMoveDestination
}

/** The ⋯ item that moves a server's page between this desktop and the server. Mounted only while the menu is open. */
export function BrowserPageDeviceMoveItem({
  target
}: {
  target: BrowserPageDeviceMoveTarget
}): React.JSX.Element | null {
  const { environmentId, destination } = target
  const available = useAppStoreWithHostStatuses((state, statuses) =>
    destination === 'client'
      ? runtimeHostsPagesOnThisDesktop(state, environmentId, statuses, 'client')
      : statuses
          .get(environmentId)
          ?.status?.capabilities?.includes(BROWSER_SCREENCAST_RUNTIME_CAPABILITY) === true
  )
  const hostLabel = useAppStore((state) =>
    selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(environmentId))
  )
  // Closing a pinned tab asks first, maybe on the server's screen; unpin to move it.
  const pinned = useAppStore(
    (state) =>
      resolveBrowserSourceUnifiedTab(state, target.browserPageId, target.worktreeId)?.isPinned ===
      true
  )
  if (!available || pinned || !resolveBrowserPageMoveUrl(target.url)) {
    return null
  }
  return (
    <BrowserPageDeviceMoveMenuItem
      destination={destination}
      hostLabel={hostLabel}
      onSelect={() => {
        void moveBrowserPageAcrossDevices(target).then(
          (outcome) => {
            const text = browserPageMoveOutcomeText(outcome, destination)
            if (text) {
              toast.error(text)
            }
          },
          (error: unknown) => {
            console.warn('[browser-device-move] move failed:', error)
            toast.error(browserPageMoveFailureText(destination))
          }
        )
      }}
    />
  )
}

export function BrowserPageDeviceMoveMenuItem({
  destination,
  hostLabel,
  onSelect
}: {
  destination: BrowserPageMoveDestination
  hostLabel: string
  onSelect: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = destination === 'client' ? Laptop : Server
  return (
    <DropdownMenuItem title={browserPageMoveTooltip(t)} onSelect={onSelect}>
      <Icon className="size-3.5" />
      {browserPageMoveLabel(destination, hostLabel, t)}
    </DropdownMenuItem>
  )
}
