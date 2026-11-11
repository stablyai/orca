// @vitest-environment happy-dom
import type React from 'react'
import { cleanup, fireEvent, render as baseRender, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAccountRow } from '@/lib/orca-cloud/orca-cloud-agent-accounts-model'
import type { OrcaCloudAgentsStatus } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OrcaCloudAccountsView, type OrcaCloudAccountsActions } from './OrcaCloudAccounts'

// The policy line is a Radix tooltip (JA-23), which needs the provider the app mounts at its root.
const render = (ui: React.ReactElement) => baseRender(ui, { wrapper: TooltipProvider })

const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'none' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
}
const TOKEN = `sk-ant-oat01-${'x'.repeat(60)}`

function actions(overrides: Partial<OrcaCloudAccountsActions> = {}): OrcaCloudAccountsActions {
  return {
    start: vi.fn(),
    cancel: vi.fn(),
    reopen: vi.fn(),
    usePaste: vi.fn(),
    pasteToken: vi.fn(async () => null),
    remove: vi.fn(async () => null),
    setSource: vi.fn(async () => null),
    copyCode: vi.fn(),
    retryLoad: vi.fn(),
    signIn: vi.fn(),
    ...overrides
  }
}

function view(
  rows: Record<'claude' | 'codex', OrcaCloudAccountRow>,
  handlers = actions()
): OrcaCloudAccountsActions {
  render(
    <OrcaCloudAccountsView
      load={{ kind: 'ready', status: STATUS }}
      rows={rows}
      actions={handlers}
      now={0}
    />
  )
  return handlers
}

const NOT_SET_UP: OrcaCloudAccountRow = { kind: 'notSetUp', keyKind: null }

describe('OrcaCloudAccountsView', () => {
  afterEach(cleanup)

  it('keeps the policy visible, the storage note in a tooltip, and starts setup per agent', () => {
    const handlers = view({ claude: NOT_SET_UP, codex: { kind: 'notSetUp', keyKind: 'team' } })
    // JA-23: the mandatory A1 sentence stays visible in the description, verbatim.
    expect(
      screen.getByText(
        /Your Claude and ChatGPT accounts are used only in your own workspaces\. Teammates never use them\./
      )
    ).toBeTruthy()
    // Where it's kept moves from every active row into one focusable info button.
    expect(
      screen.getByRole('button', { name: 'Kept in your Orca account, never in a sandbox.' })
    ).toBeTruthy()
    expect(screen.getByText('Not set up · using the team key')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use my ChatGPT account' }))
    expect(handlers.start).toHaveBeenCalledWith('codex')
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      'Claude',
      'Codex'
    ])
  })

  it('sends a pasted token once and clears the field whatever the answer', async () => {
    const pasteToken = vi.fn(async () => 'invalid_token' as const)
    view(
      {
        claude: { kind: 'setup', setup: { phase: 'paste', reason: 'chosen' } },
        codex: NOT_SET_UP
      },
      actions({ pasteToken })
    )
    const field = document.querySelector<HTMLInputElement>('input[type="password"]')!
    fireEvent.change(field, { target: { value: TOKEN } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(pasteToken).toHaveBeenCalledTimes(1))
    expect(pasteToken).toHaveBeenCalledWith(TOKEN)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('isn’t valid'))
    expect(field.value).toBe('')
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('answers the one-time Source question (state 7)', async () => {
    const setSource = vi.fn(async () => null)
    view({ claude: { kind: 'choice', keyKind: 'team' }, codex: NOT_SET_UP }, actions({ setSource }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep the team key' }))
    await waitFor(() => expect(setSource).toHaveBeenCalledWith('claude', 'key'))
  })

  it('confirms before removing, and shows a save error without losing the row', async () => {
    const remove = vi.fn(async () => 'unavailable' as const)
    view(
      {
        claude: {
          kind: 'active',
          label: 'a@acme.dev',
          expiresAt: null,
          expiring: false,
          source: 'sign-in',
          keyKind: null,
          covered: false
        },
        codex: NOT_SET_UP
      },
      actions({ remove })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('claude'))
    await waitFor(() =>
      expect(screen.getByText('Couldn’t save to your Orca account.')).toBeTruthy()
    )
  })

  it('offers Paste a token instead on the not-set-up Claude row only (RA-5)', () => {
    const handlers = view({ claude: NOT_SET_UP, codex: NOT_SET_UP })
    const paste = screen.getAllByRole('button', { name: 'Paste a token instead' })
    expect(paste).toHaveLength(1)
    fireEvent.click(paste[0])
    expect(handlers.usePaste).toHaveBeenCalledOnce()
  })

  it('an expired row offers Renew and a ⋯ with Remove, which confirms first (RA-5)', async () => {
    const handlers = view({
      claude: { kind: 'expired', keyKind: null, covered: false },
      codex: NOT_SET_UP
    })
    expect(screen.getByRole('button', { name: 'Renew' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sign in again/ })).toBeNull()
    const menu = screen.getByRole('button', { name: 'Claude account options' })
    fireEvent.pointerDown(menu, { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }))
    const remove = await screen.findByRole('button', { name: 'Remove' })
    expect(handlers.remove).not.toHaveBeenCalled()
    fireEvent.click(remove)
    await waitFor(() => expect(handlers.remove).toHaveBeenCalledWith('claude'))
  })

  it('shows the kill switch as info with no action, and signed out with Sign in', () => {
    view({ claude: { kind: 'killSwitch' }, codex: NOT_SET_UP })
    expect(screen.getByText('Signs in for each cloud workspace')).toBeTruthy()
    expect(screen.getByText(/right now/)).toBeTruthy()
    cleanup()
    // Flag off: same title, but never worded as paused ("right now", "until it’s back").
    view({ claude: { kind: 'unavailable' }, codex: NOT_SET_UP })
    expect(screen.getByText(/isn’t available in Orca Cloud yet/)).toBeTruthy()
    expect(screen.queryByText(/right now|until it’s back/)).toBeNull()
    cleanup()
    // Both off: one muted line under the heading, no rows and no actions.
    view({ claude: { kind: 'unavailable' }, codex: { kind: 'unavailable' } })
    expect(
      screen.getByText('Claude and Codex sign in for each cloud workspace for now.')
    ).toBeTruthy()
    expect(screen.queryByText(/isn’t available in Orca Cloud yet/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    const handlers = actions()
    render(
      <OrcaCloudAccountsView
        load={{ kind: 'failed', error: 'signed_out' }}
        rows={null}
        actions={handlers}
        now={0}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(handlers.signIn).toHaveBeenCalled()
  })
})
