import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'

// A server status without the screencast capability: it has no browser to take the page.
const noBrowserServer: RuntimeEnvironmentStatus = {
  status: {
    runtimeId: 'env-1',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: []
  },
  checkedAt: 1
}

function noticeFixture(width: number, openDetails: boolean, noBrowser = false) {
  return defineFixture({
    width,
    store: noBrowser
      ? { runtimeStatusByEnvironmentId: new Map([['env-1', noBrowserServer]]) }
      : undefined,
    render: () => (
      <div className="relative h-[320px] bg-background">
        <ClientHostedBrowserUnavailableNotice
          browserPageId="page-1"
          runtimeEnvironmentId="env-1"
          worktreeId="wt-1"
          reopenUrl="https://example.com/dashboard"
          placementHostClientId={null}
        />
      </div>
    ),
    interact: openDetails
      ? (frame) => {
          frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
        }
      : undefined
  })
}

export const wide = noticeFixture(640, false)
// The frame adds 16px padding per side, so 272 is a 240px pane: the narrowest where the title stays on one line.
export const narrow = noticeFixture(272, false)
export const narrowDetailsOpen = noticeFixture(272, true)
export const narrowNoBrowser = noticeFixture(272, false, true)
