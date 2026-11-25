// The rail's account button and its one flat menu: signed in/out, setup unfinished, and a long account name.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useHelpMenuController, type SetupMilestones } from '../sidebar/chrome/help-menu-controller'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles/orca-profiles'
import { AppRailAccountMenu } from './AppRailAccountMenu'
import { AppRail } from './AppRail'
import { useAppStore } from '@/store'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'

const SIGNED_OUT: OrcaProfileAuthStatus = {
  activeProfileId: 'fixture',
  configured: true,
  state: 'local',
  persistence: 'encrypted'
}
const cloudAccount = (displayName: string, email: string): OrcaProfileAuthStatus => ({
  ...SIGNED_OUT,
  state: 'connected',
  cloud: { cloudProfileId: 'c1', userId: 'u1', email, displayName, linkedAt: 1 }
})
const ALEX = cloudAccount('Alex Chen', 'alex@example.com')
const LONG = cloudAccount(
  'Alexandra Montgomery-Whitfield',
  'alexandra.montgomery-whitfield@example.com'
)
const SETUP: SetupMilestones = { done: 3, total: 5 }

function RailShell({
  milestones = null,
  height = 600
}: {
  milestones?: SetupMilestones | null
  height?: number
}): React.JSX.Element {
  const help = useHelpMenuController(null, 'grouped')
  return (
    <div className="flex" style={{ height }}>
      <div className="flex w-10 shrink-0 flex-col items-center justify-end border-r border-worktree-sidebar-border bg-worktree-sidebar pb-1">
        <AppRailAccountMenu
          help={help}
          milestones={milestones}
          settingsActive={false}
          onOpenSettings={() => {}}
          tabStop
        />
      </div>
      <div className="flex-1 bg-background" />
      {help.dialog}
    </div>
  )
}

/** Open the menu the way a keyboard user would. */
function openMenu(frame: HTMLElement): Promise<void> {
  const button = frame.querySelector<HTMLElement>('[data-app-rail-item="account"]')
  button?.focus()
  button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return new Promise((resolve) => setTimeout(resolve, 300))
}

export const signedIn = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <RailShell height={120} />
})
export const signedOut = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => <RailShell height={120} />
})
export const setupSignedIn = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <RailShell height={120} milestones={SETUP} />
})
export const setupSignedOut = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => <RailShell height={120} milestones={SETUP} />
})

export const signedInOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <RailShell />,
  interact: openMenu
})
export const signedOutOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => <RailShell />,
  interact: openMenu
})
export const setupOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <RailShell milestones={SETUP} />,
  interact: openMenu
})
export const setupSignedOutOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => <RailShell milestones={SETUP} />,
  interact: openMenu
})
export const longNameOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: LONG },
  render: () => <RailShell />,
  interact: openMenu
})
/** A short window: the menu scrolls within it instead of running off screen. */
export const shortWindowOpen = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <RailShell height={320} />,
  interact: openMenu
})

/** The whole rail: the account button is pinned at the bottom; a short window folds destinations into More. */
function FullRail({ height }: { height: number }): React.JSX.Element {
  return (
    <div className="flex" style={{ height }}>
      {/* The app's left column is a fixed-width flex column; the rail fills its height. */}
      <div className="flex w-10 shrink-0 flex-col">
        <AppRail listVisible />
      </div>
      <div className="flex-1 bg-background" />
    </div>
  )
}
export const railTall = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: ALEX },
  render: () => <FullRail height={420} />
})
export const railShort = defineFixture({
  width: 300,
  store: { orcaProfileAuthStatus: SIGNED_OUT },
  render: () => <FullRail height={170} />
})

const SettingsPage = React.lazy(() => import('../settings/Settings'))

/** The rail next to the page area, mounting the real Settings page the way the app shell does. */
function RailWithPage(): React.JSX.Element {
  const activeView = useAppStore((s) => s.activeView)
  return (
    <div className="flex" style={{ height: 640 }}>
      <div className="flex w-10 shrink-0 flex-col">
        <AppRail listVisible />
      </div>
      <div data-fixture-active-view={activeView} className="flex min-w-0 flex-1 flex-col">
        {activeView === 'settings' ? (
          // The app shell provides the confirmation dialog Settings uses for unsaved changes.
          <ConfirmationDialogProvider>
            <React.Suspense fallback={null}>
              <SettingsPage />
            </React.Suspense>
          </ConfirmationDialogProvider>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Workspaces</div>
        )}
      </div>
    </div>
  )
}
/** Signed in; Sign out's IPC is stubbed to sign the window out, the only thing faked here. */
export const railWithPage = defineFixture({
  width: 900,
  store: {
    orcaProfileAuthStatus: ALEX,
    signOutCurrentOrcaProfile: async () => {
      useAppStore.setState({ orcaProfileAuthStatus: SIGNED_OUT })
      return { status: 'signed-out', auth: SIGNED_OUT, activeProfileId: 'fixture', profiles: [] }
    }
  },
  render: () => <RailWithPage />
})
