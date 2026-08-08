// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  importAccount: vi.fn(),
  select: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn()
}))

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => React.createElement('span', { 'data-testid': 'command-code-icon' })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { CommandCodeAccountsSection } from './CommandCodeAccountsSection'

const account = {
  id: 'account-a',
  label: 'Work',
  userName: 'work-user',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}

describe('CommandCodeAccountsSection', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.importAccount.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.select.mockResolvedValue({ accounts: [account], activeAccountId: null })
    mocks.rename.mockResolvedValue({ accounts: [account], activeAccountId: 'account-a' })
    mocks.remove.mockResolvedValue({ accounts: [], activeAccountId: null })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        commandCodeAccounts: {
          list: mocks.list,
          import: mocks.importAccount,
          select: mocks.select,
          rename: mocks.rename,
          remove: mocks.remove
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows only safe account metadata and explains the bounded copy scope', async () => {
    render(<CommandCodeAccountsSection />)

    expect(await screen.findByText('Work')).toBeInTheDocument()
    expect(screen.getByText('work-user')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Import only auth.json from an existing Command Code home. Sessions, settings, taste, skills, and MCP data stay in the original home.'
      )
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('managedAuthPath')
    expect(document.body.textContent).not.toContain('apiKey')
  })

  it('imports an existing home with the required label', async () => {
    render(<CommandCodeAccountsSection />)
    await screen.findByText('Work')

    fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Choose home…' }))

    await waitFor(() => expect(mocks.importAccount).toHaveBeenCalledWith({ label: 'Personal' }))
  })

  it('requires confirmation before deleting the managed auth copy', async () => {
    render(<CommandCodeAccountsSection />)
    await screen.findByText('Work')

    fireEvent.click(screen.getByRole('button', { name: 'Remove Command Code account' }))

    expect(screen.getByRole('dialog')).toHaveTextContent(
      'The original home and system default remain unchanged.'
    )
    expect(mocks.remove).not.toHaveBeenCalled()
  })
})
