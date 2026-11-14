import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudToastCard } from '@/components/orca-cloud/cloud-toast-stack'
import { TeamMfaBanner } from './TeamMfaBanner'
import { TeamMfaBlockedScreen } from './TeamMfaBlockedScreen'

const NOW = Date.UTC(2026, 10, 18, 15)
const DAY = 86_400_000
const setupUrl = 'https://cloud.orca.dev/v1/account/security'
const noop = (): void => {}
const width = 760

function frame(children: React.ReactNode, frameWidth = width) {
  return defineFixture({
    width: frameWidth,
    render: () => <div className="bg-background px-8 py-6">{children}</div>
  })
}

// ---- Banner: a member without MFA, before the deadline ----

const banner = (daysLeft: number, frameWidth = width) =>
  frame(
    <TeamMfaBanner
      teamName="Acme Engineering"
      enforceAt={NOW + daysLeft * DAY}
      now={NOW}
      setupUrl={setupUrl}
      onSetUp={noop}
    />,
    frameWidth
  )

export const bannerTwoWeeks = banner(14)
export const bannerOneDay = banner(1)
export const bannerNarrow = banner(6, 420)
// ---- Sidebar banner stack: the app-level reminder, at sidebar widths ----

const sidebar = (daysLeft: number, sidebarWidth: number) =>
  defineFixture({
    width: sidebarWidth,
    render: () => (
      <div className="bg-worktree-sidebar py-2">
        <TeamMfaBanner
          variant="sidebar"
          teamName="Acme Engineering"
          enforceAt={NOW + daysLeft * DAY}
          now={NOW}
          setupUrl={setupUrl}
          onSetUp={noop}
          blocked={daysLeft < 0}
        />
      </div>
    )
  })

export const sidebarTwoWeeks = sidebar(14, 280)
/** Three days or fewer: the warning look. */
export const sidebarThreeDays = sidebar(3, 280)
export const sidebarOneDay = sidebar(1, 280)
/** After the deadline: no access until set up. */
export const sidebarBlocked = sidebar(-2, 280)
/** The narrowest sidebar. */
export const sidebarBlockedNarrow = sidebar(-2, 220)

// ---- The one-time toast, for people who keep the sidebar collapsed ----

export const toast = frame(
  <CloudToastCard
    view={{
      priority: 'action',
      lines: [
        {
          key: 'mfa',
          text: 'Acme Engineering requires two-factor authentication from December 2, 2026.',
          action: { label: 'Set up two-factor', primary: true, onClick: noop }
        }
      ]
    }}
    onDismiss={noop}
  />,
  420
)

// ---- Blocked screen: after the deadline ----

const blocked = (props: { checking?: boolean; stillMissing?: boolean; personal?: boolean }) =>
  frame(
    <TeamMfaBlockedScreen
      teamName="Acme Engineering"
      enforceAt={NOW - 2 * DAY}
      setupUrl={setupUrl}
      checking={props.checking === true}
      stillMissing={props.stillMissing === true}
      onSetUp={noop}
      onRecheck={noop}
      {...(props.personal === false ? {} : { onUsePersonal: noop })}
    />
  )

export const blockedScreen = blocked({})
export const blockedChecking = blocked({ checking: true })
/** "I've set it up" found no MFA yet. */
export const blockedStillMissing = blocked({ stillMissing: true })
