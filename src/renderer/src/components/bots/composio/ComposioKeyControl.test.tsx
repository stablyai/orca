// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), openUrl: vi.fn(), confirm: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({ openBotHomeTab: vi.fn() }))

import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { ComposioKeyControl } from './ComposioKeyControl'

function show(key: { key: string; hint: string | null }) {
  mocks.rpc
    .mockReset()
    .mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.composio.key' ? key : {}
    )
  return render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      <ComposioKeyControl hostId="local" />
    </ConfirmationDialogContext.Provider>
  )
}

describe('the Composio key control', () => {
  beforeEach(() => {
    Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  })
  afterEach(cleanup)

  it('asks for the key first, with a link to Composio’s API Keys page', async () => {
    show({ key: 'none', hint: null })
    expect(await screen.findByLabelText('Composio API key')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Get a key/ }))
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'https://dashboard.composio.dev/~/project/settings/api-keys'
    )
  })

  it('shows a saved key as one line, and its Change opens the paste step', async () => {
    show({ key: 'ok', hint: 'ab12' })
    expect(await screen.findByText('Composio key · ends in ab12')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(await screen.findByRole('button', { name: 'Replace key' })).toBeTruthy()
    mocks.confirm.mockResolvedValueOnce(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(expect.anything(), 'bots.composio.removeKey', {
        alsoEvents: false
      })
    )
  })
})
