// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotRequestCard } from '../../../../shared/bots/bot-request-card'
import { NativeChatClientAskRequestCard } from './NativeChatClientAskRequestCard'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
// The chat's host is another computer than the one the ask went to.
vi.mock('@/components/bots/use-paired-server-client-mentions', () => ({
  useOwnInstallation: () => 'inst_host'
}))
vi.mock('@/components/bots/use-paired-server-asks', () => ({
  useHeldPairedServerAsk: () => false
}))
// Read from a chat whose host is this computer; neither the owner nor the badge needs the app store.
vi.mock('./media/visuals/native-chat-visual-owner', () => ({
  useNativeChatVisualOwner: () => ({ target: { kind: 'local' } })
}))
vi.mock('@/components/bots/BotMentionHostBadge', () => ({
  BotMentionHostText: ({ label }: { label: string }) => <span title={label}>{label}</span>
}))

afterEach(() => {
  cleanup()
  mocks.call.mockReset()
})

async function renderAsk(computer: string): Promise<void> {
  mocks.call.mockResolvedValue({ outcome: null, answer: null, mailIds: [] })
  const card: BotRequestCard = {
    toBotId: 'docs',
    toBotName: 'Docs',
    purpose: 'question',
    subject: 'Where is the guide?',
    messageId: 'mail_1',
    client: { installationId: 'inst_paired', computer }
  }
  render(
    <NativeChatClientAskRequestCard
      card={card}
      client={card.client!}
      cardId="card_1"
      timestamp={null}
    />
  )
  await act(async () => {})
}

describe('an ask waiting on a paired computer', () => {
  it('names the computer it waits on', async () => {
    await renderAsk('Studio Mac')
    expect(screen.getByText('· Waiting for approval on Studio Mac')).toBeTruthy()
  })

  it.each(['', '   '])('falls back to "Paired computer" when its name is %j', async (name) => {
    await renderAsk(name)
    expect(screen.getByText('· Waiting for approval on Paired computer')).toBeTruthy()
    expect(screen.getByTitle('Paired computer')).toBeTruthy()
  })
})
