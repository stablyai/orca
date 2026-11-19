// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BotSharedLinksList } from './BotSharedLinksList'

const calls = vi.hoisted(() => {
  const rpc: { method: string; params: unknown }[] = []
  return { rpc }
})

// The runtime boundary: one live link, made by a bot this computer doesn't have.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_host: unknown, method: string, params: unknown) => {
    calls.rpc.push({ method, params })
    if (method === 'bots.list') {
      return { bots: [] }
    }
    return method === 'bots.share.status'
      ? {
          status: 'ok',
          value: [
            {
              id: 'share-1',
              url: 'https://app.onorca.dev/bots/share/share-1',
              packageId: 'package-1',
              name: 'bot-deleted',
              displayName: 'Release notes',
              createdAt: '2026-11-08T00:00:00.000Z',
              canonical: true,
              pinnedVersionId: 'v1'
            }
          ]
        }
      : { status: 'ok', value: true }
  }
}))

afterEach(() => {
  cleanup()
  calls.rpc.length = 0
})

it("names and stops a link whose bot isn't on this computer", async () => {
  render(<BotSharedLinksList />)
  const menu = await screen.findByRole('button', { name: 'More actions for Release notes' })
  fireEvent.pointerDown(menu, { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Stop sharing' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing' }))

  await waitFor(() =>
    expect(calls.rpc).toContainEqual({ method: 'bots.share.stop', params: { shareId: 'share-1' } })
  )
})
