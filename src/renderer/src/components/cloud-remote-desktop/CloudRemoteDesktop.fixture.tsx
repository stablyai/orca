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
import { RemoteDesktopKeyboardHintView } from './RemoteDesktopKeyboardHint'

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
export const sandboxStarting = toastFixture({ kind: 'failed', code: 'starting' })
export const archived = toastFixture({ kind: 'failed', code: 'archived' })
/** After Wake sandbox or Unarchive: the desktop opens by itself once the sandbox is awake. */
export const waking = toastFixture({ kind: 'waking', via: 'wake' })
export const unarchiving = toastFixture({ kind: 'waking', via: 'unarchive' })
export const wakeFailed = toastFixture({ kind: 'failed', code: 'wake_failed' })

function keyboardHintFixture(kind: 'captured' | 'released', chord: string, width = 520) {
  return defineFixture({
    width,
    render: () => (
      // The hint floats over the desktop at the top of the tab's page area.
      <div className="relative h-[120px] overflow-hidden bg-[#1e1f22]">
        <RemoteDesktopKeyboardHintView kind={kind} visible chord={chord} />
      </div>
    )
  })
}

export const keyboardCaptured = keyboardHintFixture('captured', '⌃⌘')
export const keyboardCapturedWindows = keyboardHintFixture('captured', 'Ctrl+Alt')
export const keyboardReleased = keyboardHintFixture('released', '⌃⌘')
/** A narrow split pane: the hint wraps instead of clipping. */
export const keyboardCapturedNarrow = keyboardHintFixture('captured', '⌃⌘', 320)
