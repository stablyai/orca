// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { EnterpriseSsoView } from './EnterpriseSsoView'
import { fixtureEnterprise, fixtureSsoProps } from './enterprise-sso.fixtures'
import { useEnterpriseSso } from './use-enterprise-sso'

// The setup link lets whoever holds it configure the team's sign-in. Opening it and copying it
// must be the same thing: a link auth mints for this owner, valid for an hour, shown to nobody else.

const SETUP_URL = 'https://auth.onorca.dev/saml/setup/one-time-abc123'
const EXPIRES_AT = Date.UTC(2026, 10, 12, 19, 0, 0)

const orgEnterprise = vi.fn()
const orgSsoSetupLink = vi.fn()
const openUrl = vi.fn()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()

/** The pane's wiring in miniature: the hook feeding the view. */
function Harness(): React.JSX.Element {
  const sso = useEnterpriseSso('org_acme', true)
  return (
    <EnterpriseSsoView
      {...fixtureSsoProps(sso.state, {
        setupNotice: sso.setupNotice,
        setupLink: sso.mintSetupLink,
        onOpenSetup: sso.openSetup
      })}
    />
  )
}

const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
  vi.spyOn(console, level).mockImplementation(() => {})
)

beforeEach(() => {
  orgEnterprise.mockReset().mockResolvedValue({ status: 'ok', enterprise: fixtureEnterprise() })
  orgSsoSetupLink
    .mockReset()
    .mockResolvedValue({ status: 'ok', url: SETUP_URL, expiresAt: EXPIRES_AT })
  openUrl.mockReset()
  writeClipboardText.mockReset().mockResolvedValue(undefined)
  toast.success.mockReset()
  toast.error.mockReset()
  for (const spy of consoleSpies) {
    spy.mockClear()
  }
  Object.assign(window, {
    api: {
      orcaProfiles: { orgEnterprise, orgSsoSetupLink },
      shell: { openUrl },
      ui: { writeClipboardText }
    }
  })
})
afterEach(cleanup)

function loggedAnywhere(text: string): boolean {
  return consoleSpies.some((spy) =>
    spy.mock.calls.some((call) => call.some((value) => String(value).includes(text)))
  )
}

describe('the SSO setup link, opened or copied', () => {
  it('Copy link mints the link the same way as opening it, and copies it without opening', async () => {
    render(<Harness />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Set up SSO' })
    await user.click(screen.getByRole('button', { name: 'More link options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(SETUP_URL))
    // The same request the button makes: auth's one route, which gives every link a 1-hour life.
    expect(orgSsoSetupLink).toHaveBeenCalledTimes(1)
    expect(orgSsoSetupLink).toHaveBeenCalledWith({ orgId: 'org_acme' })
    expect(openUrl).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Set up SSO' }))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(SETUP_URL))
    expect(orgSsoSetupLink).toHaveBeenCalledTimes(2)
    expect(orgSsoSetupLink).toHaveBeenLastCalledWith({ orgId: 'org_acme' })
  })

  it('never logs the link, and never keeps it on the page', async () => {
    const { container } = render(<Harness />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Set up SSO' })
    await user.click(screen.getByRole('button', { name: 'More link options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalled())
    await user.click(screen.getByRole('button', { name: 'Set up SSO' }))
    await waitFor(() => expect(openUrl).toHaveBeenCalled())
    expect(loggedAnywhere('one-time-abc123')).toBe(false)
    expect(document.body.innerHTML).not.toContain('one-time-abc123')
    expect(container.innerHTML).not.toContain('one-time-abc123')
  })

  it('a refused link copies nothing, opens nothing, and says why', async () => {
    orgSsoSetupLink.mockResolvedValue({ status: 'recent-sign-in-required' })
    const { container } = render(<Harness />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Set up SSO' })
    await user.click(screen.getByRole('button', { name: 'More link options' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Copy link' }))
    await waitFor(() =>
      expect(container.textContent).toContain('sign out and sign in to Orca again')
    )
    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
