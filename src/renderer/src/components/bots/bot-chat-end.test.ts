// What ending a bot side chat says: a line only for an outcome the host proved, nothing for the rest.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatEndResult } from '../../../../shared/bots/bot-chat-end'

const toast = vi.hoisted(() => ({ success: vi.fn(), message: vi.fn() }))
const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/lib/bot-hosts', () => ({ callBotRpc: rpc.call }))
vi.mock('@/lib/bot-catalog', () => ({ readBotsEnabled: () => true }))
vi.mock('@/lib/bot-host-status', () => ({ botHostHas: () => true }))
vi.mock('./bot-session-open', () => ({ openBotSession: vi.fn() }))

import { endBotChatFromRow, showBotChatTabCloseResult } from './bot-chat-end'
import { closeBotSideChatTab } from '../../runtime/native-chat/tab-retirement/bot-side-chat-tab-close'

const BOT: Bot = {
  id: 'bot-1',
  name: 'Atlas',
  hostId: 'local',
  folder: 'atlas',
  folderWorkspaceId: 'bot-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'home-chat',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const SIDE = 'side-chat'

/** Every line shown, as "title" or "title: button". */
function said(): string[] {
  return [...toast.success.mock.calls, ...toast.message.mock.calls].map(([title, options]) =>
    options?.action ? `${title}: ${options.action.label}` : String(title)
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('closing a bot side chat tab ("x")', () => {
  const answers: [BotChatEndResult, string[]][] = [
    [{ outcome: 'ended', title: null }, ['Chat ended: Reopen']],
    [
      { outcome: 'kept', reasons: [{ kind: 'replying' }], background: true },
      ['Kept in background']
    ],
    [
      { outcome: 'kept', reasons: [{ kind: 'stopping' }], background: true },
      ['Kept in background']
    ],
    [
      { outcome: 'refused', refusal: { kind: 'linked', source: 'slack' }, background: true },
      ['Kept in background (linked to a thread)']
    ],
    // Not proven: a background write that did not commit, a late x, an unknown write.
    [{ outcome: 'kept', reasons: [{ kind: 'replying' }] }, []],
    [{ outcome: 'superseded' }, []],
    [{ outcome: 'unknown' }, []],
    [{ outcome: 'refused', refusal: { kind: 'home' } }, []]
  ]

  it.each(answers)('answers %j with %j', (result, lines) => {
    showBotChatTabCloseResult(BOT, SIDE, result)
    expect(said()).toEqual(lines)
  })

  it('tells the window to refresh the tab, silently, when nothing proven changed it', async () => {
    const close = (answer: () => Promise<BotChatEndResult>) => {
      rpc.call.mockImplementationOnce(answer)
      return closeBotSideChatTab(
        { target: { kind: 'local' }, worktreeId: 'bot-home', sessionId: SIDE },
        { bot: BOT, showing: 'showing-1' },
        () => Promise.resolve(true)
      )
    }

    expect(await close(() => Promise.resolve({ outcome: 'superseded' }))).toBe(false)
    expect(await close(() => Promise.resolve({ outcome: 'unknown' }))).toBe(false)
    expect(await close(() => Promise.reject(new Error('transport lost')))).toBe(false)
    expect(said()).toEqual([])

    expect(await close(() => Promise.resolve({ outcome: 'ended', title: null }))).toBe(true)
    expect(rpc.call).toHaveBeenLastCalledWith(BOT, 'bots.endChat', {
      chat: SIDE,
      intent: 'x',
      showing: 'showing-1',
      botId: BOT.id,
      opId: expect.any(String)
    })
  })
})

describe("a chat row's End chat", () => {
  it('says ended, cannot end yet, cannot end, or could not confirm', async () => {
    const row = (result: BotChatEndResult | Error) => {
      rpc.call.mockImplementationOnce(() =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
      )
      return endBotChatFromRow(BOT, SIDE)
    }

    expect(await row({ outcome: 'ended', title: null })).toBe(true)
    expect(await row({ outcome: 'kept', reasons: [{ kind: 'stopping' }] })).toBe(false)
    expect(await row({ outcome: 'kept', reasons: [{ kind: 'ran-workers' }] })).toBe(false)
    expect(await row({ outcome: 'unknown' })).toBe(false)
    expect(await row(new Error('transport lost'))).toBe(false)

    expect(said()).toEqual([
      'Chat ended: Reopen',
      "Can't end yet: Details",
      "Can't end this chat: Details",
      "Couldn't confirm the chat ended",
      "Couldn't confirm the chat ended"
    ])
  })
})
