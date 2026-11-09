import { defineFixture } from '../../component-fixtures/component-fixture'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import SidebarToolbar from './SidebarToolbar'
import { registerPlanBillingMenuItem } from '../billing/register-plan-billing-menu-item'
import { recordBillingStatus } from '../billing/billing-summary-store'
import { sampleTeam } from '../billing/plan-billing-fixtures'

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const openAccountMenu = async (frame: HTMLElement): Promise<void> => {
  frame
    .querySelector('[data-account-menu-trigger]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  await settle()
}

const openHelpSubmenu = async (frame: HTMLElement): Promise<void> => {
  await openAccountMenu(frame)
  const help = Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
  ).find((element) => element.textContent?.includes('Help'))
  help?.focus()
  help?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await settle()
}

const signedIn: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'connected',
  persistence: 'encrypted',
  cloud: {
    cloudProfileId: 'fixture',
    userId: 'fixture-user',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    linkedAt: 0
  }
}

const signedInWithBilling: OrcaProfileAuthStatus = {
  ...signedIn,
  cloud: { ...signedIn.cloud!, activeOrgId: 'org-acme', activeOrgName: 'Acme' },
  capabilities: { flags: { billing: true }, refreshedAt: 0 }
}

/** Registers the billing items as main.tsx does, with a known plan state. */
const withBilling = (subscribed: boolean) => (): void => {
  const result = {
    status: 'ok' as const,
    entitlement: subscribed
      ? sampleTeam
      : { ...sampleTeam, plan: null, planLabel: null, status: 'none' }
  }
  // The registration re-reads billing when the account changes; answer like the service would.
  window.api.orcaProfiles.billingStatus = async () => result
  registerPlanBillingMenuItem()
  recordBillingStatus(result)
}

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'local-default',
  configured: true,
  state: 'local',
  persistence: 'encrypted'
}

const footer = ({
  width = 303,
  height = 96,
  authStatus = signedOut,
  interact,
  setup
}: {
  width?: number
  height?: number
  authStatus?: OrcaProfileAuthStatus
  interact?: (frame: HTMLElement) => Promise<void>
  setup?: () => void
}) =>
  defineFixture({
    width,
    store: { persistedUIReady: true, orcaProfileAuthStatus: authStatus },
    interact,
    setup,
    render: () => (
      <div
        style={{ height }}
        className="flex flex-col bg-worktree-sidebar text-worktree-sidebar-foreground"
      >
        <SidebarToolbar workspaceBoardOpen={false} onWorkspaceBoardToggle={() => {}} />
      </div>
    )
  })

export const signedOutFooter = footer({})
export const signedInFooter = footer({ authStatus: signedIn })
export const narrowSignedInFooter = footer({ width: 220, authStatus: signedIn })
export const signedOutMenu = footer({ height: 260, interact: openAccountMenu })
export const signedInMenu = footer({ height: 260, authStatus: signedIn, interact: openAccountMenu })
export const helpSubmenu = footer({
  width: 560,
  height: 480,
  authStatus: signedIn,
  interact: openHelpSubmenu
})
export const signedInMenuNoPlan = footer({
  height: 340,
  authStatus: signedInWithBilling,
  setup: withBilling(false),
  interact: openAccountMenu
})
export const signedInMenuOnTeam = footer({
  height: 320,
  authStatus: signedInWithBilling,
  setup: withBilling(true),
  interact: openAccountMenu
})
