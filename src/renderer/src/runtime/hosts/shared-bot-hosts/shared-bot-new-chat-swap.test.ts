import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SharedBotHostView } from '../../../../../shared/bots/shared-bot-hosts'
import { installSharedBotHostCatalog } from './shared-bot-host-catalog'
import { swapSharedBotNewChat } from './shared-bot-new-chat-swap'

const HOST: SharedBotHostView = {
  environmentId: 'shared-env',
  shareId: 'share-1',
  botId: 'bot-1',
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  link: 'live',
  holds: true,
  held: []
}

let uninstall: () => void
const call = vi.fn()

beforeEach(async () => {
  call.mockReset().mockResolvedValue({
    id: 'bots.session.start',
    ok: true,
    result: { sessionId: 'chat-real-01' },
    _meta: { runtimeId: 'r' }
  })
  vi.stubGlobal('window', {
    api: { sharedBotHosts: { list: async () => [HOST], onChanged: () => () => {}, call } }
  })
  uninstall = installSharedBotHostCatalog()
  await Promise.resolve()
})

afterEach(() => {
  uninstall()
  vi.unstubAllGlobals()
})

describe('a placeholder tab for a new chat started while the owner’s computer was away', () => {
  it('moves to the chat the host starts for its id once that computer is reachable', async () => {
    const open = vi.fn()
    const close = vi.fn()
    await swapSharedBotNewChat(
      HOST,
      'folder:ivy-home',
      { id: 'tab-1', entityId: 'shared-new-1' },
      { open, close }
    )
    expect(call).toHaveBeenCalledWith({
      environmentId: 'shared-env',
      method: 'bots.session.start',
      params: { botId: 'bot-1', newChatId: 'shared-new-1' }
    })
    expect(open).toHaveBeenCalledWith('folder:ivy-home', 'chat-real-01')
    expect(close).toHaveBeenCalledWith('tab-1')
  })
})
