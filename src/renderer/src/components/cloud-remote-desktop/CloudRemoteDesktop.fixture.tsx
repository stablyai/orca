import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import {
  CloudRemoteDesktopToast,
  type CloudRemoteDesktopToastState
} from './CloudRemoteDesktopToast'
import { RemoteDesktopMenuEntry } from './RemoteDesktopMenuEntry'

const noop = (): void => {}

function toastFixture(state: CloudRemoteDesktopToastState) {
  return defineFixture({
    width: 380,
    render: () => (
      <div className="bg-background p-3">
        <CloudRemoteDesktopToast state={state} onAction={noop} onDismiss={noop} />
      </div>
    )
  })
}

/** Entry point: first item of a cloud workspace's context menu. */
export const menuEntry = defineFixture({
  width: 320,
  render: () => (
    <div className="relative h-[180px] overflow-hidden bg-background">
      <FixtureCodeBackdrop />
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger className="absolute top-2 left-2 size-px" />
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuLabel>desk-demo</DropdownMenuLabel>
          <RemoteDesktopMenuEntry onSelect={noop} />
          <DropdownMenuItem>Sleep</DropdownMenuItem>
          <DropdownMenuItem>Mark unread</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export const starting = toastFixture({ kind: 'starting', slow: false })
export const stillStarting = toastFixture({ kind: 'starting', slow: true })
export const asleep = toastFixture({ kind: 'failed', code: 'not_running' })
export const notInstalled = toastFixture({ kind: 'failed', code: 'not_installed' })
export const unavailable = toastFixture({ kind: 'failed', code: 'unavailable' })
export const connectFailed = toastFixture({ kind: 'failed', code: 'forward_failed' })
export const signedOut = toastFixture({ kind: 'failed', code: 'signed_out' })
export const notCloud = toastFixture({ kind: 'failed', code: 'not_cloud' })
