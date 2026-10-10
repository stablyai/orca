// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { CodexManagedAccountSummary } from '../../../../shared/managed-account-types'
import { renderCodexAccountRow } from './accounts-pane-codex-account-row'

const account: CodexManagedAccountSummary = {
  id: 'account-1',
  email: 'user@example.com',
  managedHomeRuntime: 'host',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

type RowModel = Parameters<typeof renderCodexAccountRow>[1]

function rowModel(
  current: CodexManagedAccountSummary,
  overrides: Partial<RowModel> = {}
): RowModel {
  return {
    settings: getDefaultSettings(''),
    accountRuntime: { runtime: 'host', label: 'This device' },
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false, ownerPlatform: 'darwin' },
    activeCodexAccountId: null,
    codexAccounts: {
      accounts: current.removalPending ? [] : [current],
      ...(current.removalPending ? { pendingRemovals: [current] } : {}),
      activeAccountId: null
    },
    codexAction: 'idle',
    codexRateLimits: null,
    codexRateLimitTarget: { runtime: 'host', wslDistro: null },
    isRemoteAccountScope: false,
    runCodexAccountAction: vi.fn(async () => {}),
    setRemoveCodexTarget: vi.fn(),
    ...overrides
  }
}

const unmounts: (() => Promise<void>)[] = []
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount()
  }
  vi.unstubAllGlobals()
})

async function renderRow(current: CodexManagedAccountSummary, model = rowModel(current)) {
  const container = document.createElement('div')
  const root = createRoot(container)
  unmounts.push(async () => {
    await act(async () => root.unmount())
  })
  await act(async () => root.render(renderCodexAccountRow(current, model)))
  const buttons = [...container.querySelectorAll('button')]
  const select = buttons.find((button) => button.textContent?.includes(current.email))
  const reauthenticate = buttons.find((button) => button.textContent?.includes('Re-authenticate'))
  const remove = buttons.find((button) => button.textContent?.trim() === 'Remove')
  if (!select || !reauthenticate || !remove) {
    throw new Error('Expected account selection and maintenance controls')
  }
  return { container, select, reauthenticate, remove, model }
}

describe('Codex account row removal recovery', () => {
  it.each(['host', 'wsl'] as const)(
    'offers only removal retry for a pending %s account',
    async (runtime) => {
      const current = {
        ...account,
        removalPending: true,
        managedHomeRuntime: runtime,
        ...(runtime === 'wsl' ? { wslDistro: 'Ubuntu' } : {})
      }
      const row = await renderRow(current)
      expect(row.container.textContent).toContain('Removal pending')
      expect(row.container.textContent).toContain('Choose Remove to retry cleanup.')
      expect(row.select.disabled).toBe(true)
      expect(row.reauthenticate.disabled).toBe(true)
      expect(row.remove.disabled).toBe(false)
      await act(async () => {
        row.select.click()
        row.reauthenticate.click()
        row.remove.click()
      })
      expect(row.model.runCodexAccountAction).not.toHaveBeenCalled()
      expect(row.model.setRemoveCodexTarget).toHaveBeenCalledWith({
        id: current.id,
        runtime: { runtime, wslDistro: runtime === 'wsl' ? 'Ubuntu' : null }
      })
    }
  )

  it('keeps normal account selection and maintenance available', async () => {
    const row = await renderRow(account)
    expect(row.container.textContent).not.toContain('Removal pending')
    expect(row.select.disabled).toBe(false)
    expect(row.reauthenticate.disabled).toBe(false)
    expect(row.remove.disabled).toBe(false)
  })

  it.each([{ codexAction: 'remove:account-1' as const }, { accountRuntimeUnavailable: true }])(
    'keeps removal retry disabled while the runtime cannot accept it: %s',
    async (overrides) => {
      const current = { ...account, removalPending: true }
      const row = await renderRow(current, rowModel(current, overrides))
      expect(row.remove.disabled).toBe(true)
    }
  )

  it('allows removal retry on the remote account owner without enabling remote reauthentication', async () => {
    const current = { ...account, removalPending: true }
    const row = await renderRow(
      current,
      rowModel(current, {
        isRemoteAccountScope: true,
        accountVisibilityOptions: { remoteOwner: true, ownerPlatform: 'linux' }
      })
    )
    expect(row.select.disabled).toBe(true)
    expect(row.reauthenticate.disabled).toBe(true)
    expect(row.remove.disabled).toBe(false)
  })
})
