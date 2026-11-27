import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'

function noticeFixture(width: number, openDetails: boolean) {
  return defineFixture({
    width,
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
