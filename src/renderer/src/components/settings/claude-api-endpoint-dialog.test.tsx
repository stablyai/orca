// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { ClaudeApiEndpointButton } from './claude-api-endpoint-dialog'

const STATE: ClaudeRateLimitAccountsState = { accounts: [], activeAccountId: null }
const saveApiEndpoint = vi.fn(async () => STATE)

beforeEach(() => {
  saveApiEndpoint.mockClear()
  Object.assign(window, {
    api: { ...window.api, claudeAccounts: { ...window.api?.claudeAccounts, saveApiEndpoint } }
  })
})
afterEach(cleanup)

function value(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value
}

describe('Claude API endpoint dialog', () => {
  it('fills the Sakana AI preset and saves it with the typed token', async () => {
    const onSaved = vi.fn()
    render(
      <ClaudeApiEndpointButton variant="outline" disabled={false} onSaved={onSaved}>
        Add API Endpoint
      </ClaudeApiEndpointButton>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add API Endpoint' }))
    const save = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(screen.getByRole('button', { name: 'Sakana AI' }))
    expect(value('Base URL')).toBe('https://api.sakana.ai')
    expect(value('Model')).toBe('fugu')
    // A new account cannot be saved without its token.
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'test-token' } })
    fireEvent.click(save)

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(STATE))
    expect(saveApiEndpoint).toHaveBeenCalledWith({
      endpoint: {
        label: 'Sakana AI',
        baseUrl: 'https://api.sakana.ai',
        authToken: 'test-token',
        model: 'fugu',
        smallFastModel: 'fugu'
      },
      accountId: undefined
    })
  })

  it('edits an account without asking for its token again and shows a save error', async () => {
    saveApiEndpoint.mockRejectedValueOnce(new Error('The endpoint must use https.'))
    const account: ClaudeManagedAccountSummary = {
      id: 'endpoint-1',
      email: 'Sakana AI',
      authMethod: 'api-endpoint',
      apiEndpoint: { baseUrl: 'https://api.sakana.ai', model: 'fugu', smallFastModel: 'fugu' },
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    render(
      <ClaudeApiEndpointButton account={account} variant="ghost" disabled={false} onSaved={vi.fn()}>
        Edit
      </ClaudeApiEndpointButton>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Sakana AI' })).toBeNull()
    expect(value('Token')).toBe('')
    // A different host needs its own token.
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://elsewhere.example.test' }
    })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://api.sakana.ai/' }
    })
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'fugu-ultra' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The endpoint must use https.')
    expect(saveApiEndpoint).toHaveBeenCalledWith({
      endpoint: expect.objectContaining({ authToken: '', model: 'fugu-ultra' }),
      accountId: 'endpoint-1'
    })
  })
})
