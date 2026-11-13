// @vitest-environment happy-dom
// AUTH-ONLY-COPY-LINK: "Copy link" (the split's chevron) is for sign-in pages only, where people paste
// the URL into an incognito window. Billing, help, support and the GitHub App install keep a plain
// button, and nothing adds a "Copy … link" row next to them.
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PaymentIssueNotice } from '@/components/billing/PaymentIssueNotice'
import { sampleTeam } from '@/components/billing/plan-billing-fixtures'
import {
  FailureActionRow,
  type VmBuildFailureActions
} from '@/components/worktree-creation/VmBuildFailureActions'
import { translate } from '@/i18n/i18n'
import { OpenExternalSplitButton } from './OpenExternalSplitButton'

afterEach(cleanup)

const chevrons = (): number => document.querySelectorAll('[data-open-external-chevron]').length

const actions: VmBuildFailureActions = {
  onFixWithAgent: vi.fn(),
  onRetry: vi.fn(),
  onEditRecipe: vi.fn(),
  onOpenAnyway: vi.fn(),
  onStartAgain: vi.fn(),
  onDismiss: vi.fn(),
  onSeePlans: vi.fn(),
  onOpenBilling: vi.fn(),
  onCreateLocally: vi.fn(),
  onSignIn: vi.fn(),
  onShowWorkspaces: vi.fn(),
  onContactSupport: vi.fn(),
  onConnectGitHub: vi.fn(),
  onPushToGitHub: vi.fn()
}

function failureRow(kind: 'githubNotConnected' | 'noGithubRemote' | 'snapshotMissing'): void {
  render(
    <TooltipProvider>
      <FailureActionRow
        failure={{ kind }}
        cloud
        vmKept={false}
        canFixWithAgent={false}
        canManageBilling
        signingIn={false}
        connectingGitHub={false}
        actions={actions}
        t={translate}
      />
    </TooltipProvider>
  )
}

it('keeps the chevron on a sign-in button', () => {
  render(
    <OpenExternalSplitButton link="https://claude.ai/oauth/authorize" onClick={() => {}}>
      Open again
    </OpenExternalSplitButton>
  )
  expect(chevrons()).toBe(1)
})

it('"Update payment method" is a plain button', () => {
  render(
    <PaymentIssueNotice
      entitlement={{
        ...sampleTeam,
        payment: { pastDueSince: 1, graceEndsAt: null, suspendRunning: true }
      }}
      busy={false}
      onUpdatePayment={() => {}}
    />
  )
  expect(screen.getByRole('button', { name: /Update payment method/ })).toBeTruthy()
  expect(chevrons()).toBe(0)
})

it('Connect GitHub (App install) and "How to push to GitHub" are plain buttons', () => {
  failureRow('githubNotConnected')
  expect(screen.getByRole('button', { name: /Connect GitHub/ })).toBeTruthy()
  expect(chevrons()).toBe(0)
  cleanup()
  failureRow('noGithubRemote')
  expect(screen.getByRole('button', { name: /How to push to GitHub/ })).toBeTruthy()
  expect(chevrons()).toBe(0)
})

it('"Contact support" has no "Copy support link" row beside it', async () => {
  failureRow('snapshotMissing')
  const more = screen.queryAllByRole('button').find((b) => b.getAttribute('aria-haspopup'))
  expect(more).toBeTruthy()
  await userEvent.setup().click(more!)
  const menu = await screen.findByRole('menu')
  const items = within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent?.trim())
  expect(items.some((label) => label?.includes('Contact support'))).toBe(true)
  expect(items.some((label) => /copy/i.test(label ?? ''))).toBe(false)
})
