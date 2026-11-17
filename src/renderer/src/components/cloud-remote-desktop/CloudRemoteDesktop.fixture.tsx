import { FixtureCodeBackdrop } from '../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { createRef } from 'react'
import type { CloudDesktopPhase } from '@/lib/cloud-remote-desktop/use-cloud-desktop-connection'
import { CloudDesktopTabCover, CloudDesktopTabToolbar } from './CloudDesktopTabChrome'
import { RemoteDesktopMenuEntry } from './RemoteDesktopMenuEntry'
import { RemoteDesktopKeyboardHintView } from './RemoteDesktopKeyboardHint'

const noop = (): void => {}

/** A remote desktop tab's page area: its toolbar, and the cover while there is no desktop to show. */
function tabFixture(phase: CloudDesktopPhase, pending = true) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="flex h-[320px] flex-col overflow-hidden bg-background">
        <CloudDesktopTabToolbar
          chromeHeaderRef={createRef()}
          phase={phase}
          pending={pending}
          onReconnect={noop}
        />
        <div className="relative flex-1">
          <CloudDesktopTabCover
            worktreeId="wt-demo"
            phase={phase}
            pending={pending}
            onReconnect={noop}
          />
        </div>
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

/** Right after "Open remote desktop": the tab is open and focused while the desktop starts. */
export const starting = tabFixture({ kind: 'starting' })
export const asleep = tabFixture({ kind: 'asleep' })
export const waking = tabFixture({ kind: 'waking' })
export const archived = tabFixture({ kind: 'archived' })
export const notInstalled = tabFixture({ kind: 'failed', code: 'not_installed' })
export const unavailable = tabFixture({ kind: 'failed', code: 'unavailable' })
export const signedOut = tabFixture({ kind: 'failed', code: 'signed_out' })
/** A tab that was connected before: the same cover says Reconnect. */
export const reconnectFailed = tabFixture({ kind: 'failed', code: 'forward_failed' }, false)

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
