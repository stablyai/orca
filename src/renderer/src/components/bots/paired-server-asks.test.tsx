// @vitest-environment happy-dom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { PairedServerAskCard } from '../../../../shared/rpc-contract/paired-server-asks-params'
import { PairedAskNeedRow } from './BotPairedAskNeedRow'
import { usePairedServerCardsForChat } from './use-paired-server-asks'

const mocks = vi.hoisted(() => ({ open: vi.fn(), call: vi.fn() }))
vi.mock('@/lib/agent-session/open/open-agent-message-sender', () => ({
  openOrchestrationDispatch: mocks.open
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('./use-bot-host-label', () => ({ useBotHostLabel: () => 'Lab server' }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only the bot's name.
const docs = { id: 'docs', name: 'Docs', hostId: 'local' } as Bot

// A plain agent chat on the server, with no bot of its own.
const card: PairedServerAskCard = {
  messageId: 'msg_1',
  environmentId: 'env_s',
  botId: 'docs',
  rootSession: 'orca_session_id:chat_plain',
  from: { label: 'Claude on Lab server', sender: null },
  subject: 'Where is the guide?',
  body: '',
  createdAt: '2026-11-22 10:00:00'
}

afterEach(() => {
  cleanup()
  mocks.open.mockReset()
  mocks.call.mockReset()
})

describe('asks from agents on a paired server', () => {
  it("opens the server chat the ask came from, even when its agent isn't a bot", () => {
    render(<PairedAskNeedRow bot={docs} card={card} />)
    fireEvent.click(screen.getAllByRole('button', { name: /Open/ })[0]!)
    expect(mocks.open).toHaveBeenCalledWith('orca_session_id:chat_plain', 'Claude on Lab server', {
      kind: 'environment',
      environmentId: 'env_s'
    })
  })

  it('never reads the card list for a chat on this computer', () => {
    mocks.call.mockResolvedValue({ cards: [] })
    renderHook(() => usePairedServerCardsForChat(null, 'orca_session_id:chat_here'))
    expect(mocks.call).not.toHaveBeenCalled()
    renderHook(() => usePairedServerCardsForChat('env_s', 'orca_session_id:chat_plain'))
    expect(mocks.call).toHaveBeenCalledWith(expect.anything(), 'pairedServerAsks.list', {})
  })
})
