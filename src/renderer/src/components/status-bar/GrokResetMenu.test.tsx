// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GrokRateLimitResetOutcome,
  ProviderRateLimits
} from '../../../../shared/rate-limit-types'

const consumeReset = vi.fn<() => Promise<GrokRateLimitResetOutcome>>(async () => 'reset')
const updateSettings = vi.fn(async () => {})
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
const translateMock = vi.hoisted(() =>
  vi.fn((_key: string, fallback: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce(
          (text, [token, value]) => text.replace(`{{${token}}}`, String(value)),
          fallback
        )
      : fallback
  )
)
let activeRuntimeEnvironmentId: string | null = null

vi.mock('@/i18n/i18n', () => ({ translate: translateMock }))

vi.mock('sonner', () => ({ toast: { error: toastError } }))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange
  }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => {} })}
    >
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('./ProviderDetailsMenu', () => ({
  ProviderDetailsMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('./tooltip', () => ({ formatResetCreditExpiry: () => null }))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settings: {
        activeRuntimeEnvironmentId,
        skipGrokRateLimitResetConfirm: false
      },
      consumeGrokRateLimitResetCredit: consumeReset,
      updateSettings,
      openSettingsPage: vi.fn(),
      openSettingsTarget: vi.fn()
    })
}))

import { GrokResetMenu } from './GrokResetMenu'

const grok: ProviderRateLimits = {
  provider: 'grok',
  session: null,
  weekly: {
    usedPercent: 80,
    windowMinutes: 10_080,
    resetsAt: null,
    resetDescription: null
  },
  rateLimitResetCredits: { availableCount: 1, nextExpiresAt: null },
  updatedAt: 1,
  error: null,
  status: 'ok'
}

function renderMenu(): void {
  render(<GrokResetMenu grok={grok} compact={false} iconOnly={false} />)
}

describe('GrokResetMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeRuntimeEnvironmentId = null
  })

  afterEach(cleanup)

  it('confirms before redeeming a reset token', async () => {
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset now' }))
    expect(screen.getByText('Reset Grok limits?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))

    await waitFor(() => expect(consumeReset).toHaveBeenCalledOnce())
  })

  it("persists the don't-ask-again setting", async () => {
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset now' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ skipGrokRateLimitResetConfirm: true })
    )
  })

  it('disables local redemption while a remote runtime is active', () => {
    activeRuntimeEnvironmentId = 'remote-host'
    renderMenu()

    expect(screen.getByRole('menuitem', { name: 'Reset now' })).toBeDisabled()
    expect(consumeReset).not.toHaveBeenCalled()
  })

  it('disables redemption when weekly usage is 0%', () => {
    render(
      <GrokResetMenu
        grok={{ ...grok, weekly: { ...grok.weekly!, usedPercent: 0 } }}
        compact={false}
        iconOnly={false}
      />
    )

    expect(screen.getByRole('menuitem', { name: 'Reset now' })).toBeDisabled()
    expect(consumeReset).not.toHaveBeenCalled()
  })

  it('uses a semantic count placeholder for available resets', () => {
    render(
      <GrokResetMenu
        grok={{
          ...grok,
          rateLimitResetCredits: { availableCount: 2, nextExpiresAt: null }
        }}
        compact={false}
        iconOnly={false}
      />
    )

    expect(screen.getByText('2 rate-limit resets available')).toBeInTheDocument()
    expect(translateMock).toHaveBeenCalledWith(
      'components.grokResetMenu.availableMany',
      '{{count}} rate-limit resets available',
      { count: 2 }
    )
  })

  it('shows a localized failure toast when redemption fails', async () => {
    consumeReset.mockRejectedValueOnce(new Error('provider failed'))
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not use the SuperGrok reset. Try again.')
    )
  })

  it('shows a retryable toast when Grok usage cannot be verified', async () => {
    consumeReset.mockResolvedValueOnce('usageUnavailable')
    renderMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset now' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Could not verify Grok usage. Try again.')
    )
    expect(translateMock).toHaveBeenCalledWith(
      'components.grokResetMenu.usageUnavailable',
      'Could not verify Grok usage. Try again.'
    )
  })
})
