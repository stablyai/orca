import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { takeBackAllFromPhone } from '@/components/terminal-pane/viewport/take-back-all-from-phone'
import { BrowserMobileDriverOverlay } from '../assemble-chrome/feedback/BrowserMobileDriverOverlay'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'
import type { RemoteBrowserPageDriver } from './use-remote-browser-stream-viewer-state'

/** The local page's phone lock and Take back, for a page a phone drives on its host. */
export function RemoteBrowserPageDriverOverlay({
  pageDriver,
  runtimeTarget
}: {
  pageDriver: RemoteBrowserPageDriver
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
}): React.JSX.Element | null {
  const takeBack = async (all?: true): Promise<void> => {
    const target = runtimeTarget()
    const result = target
      ? await callRuntimeRpc<{ reclaimed: boolean }>(
          target,
          'browser.screencast.reclaimForDesktop',
          { browserPageId: pageDriver.browserPageId, all },
          { timeoutMs: 15_000 }
        )
      : null
    if (!result?.reclaimed) {
      throw new Error('Could not reclaim browser control')
    }
  }
  return (
    <BrowserMobileDriverOverlay
      driver={pageDriver.driver}
      onTakeBack={() => takeBack()}
      onTakeBackAll={async () => {
        // This host's phone-held pages, plus this machine's terminals and pages.
        await Promise.all([
          takeBack(true),
          takeBackAllFromPhone(useAppStore.getState().settings ?? undefined, {
            includeBrowserPages: true
          })
        ])
      }}
    />
  )
}
