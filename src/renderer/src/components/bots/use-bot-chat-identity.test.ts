// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import type { ExternalConversationLink } from '../../../../shared/connectors/external-conversation-link'
import { BotSchema } from '../../../../shared/bot-types'
import { useBotChatIdentity } from './use-bot-chat-identity'

const catalog = vi.hoisted((): { bots: unknown[]; enabled: boolean } => ({
  bots: [],
  enabled: true
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: (enabled: boolean) => (enabled ? catalog.bots : []),
  useBotsEnabled: () => catalog.enabled
}))
const initialState = useAppStore.getInitialState()
afterEach(() => useAppStore.setState(initialState, true))

function seed() {
  const bot = BotSchema.parse({
    id: 'atlas',
    name: 'Atlas',
    folder: 'atlas',
    folderWorkspaceId: 'home',
    agent: 'codex',
    hostId: 'local',
    avatar: 'mascot:A1',
    paused: false,
    slack: null,
    members: [],
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    chatSessionId: 'home-session',
    createdAt: 1,
    updatedAt: 1
  })
  catalog.bots = [bot]
  catalog.enabled = true
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'home', executionHostId: 'local' })]
  })
  return bot
}

describe('session owner bot identity', () => {
  it('does not carry Home identity into an ordinary chat or worker, or after deletion', () => {
    const bot = seed()
    const initialProps: { sessionId: string | null } = { sessionId: 'home-session' }
    const { result, rerender } = renderHook(
      ({ sessionId }) => useBotChatIdentity('folder:home', sessionId, { kind: 'local' }),
      { initialProps }
    )
    expect(result.current).toBe(bot)
    for (const sessionId of ['ordinary', 'worker', null]) {
      rerender({ sessionId })
      expect(result.current).toBeNull()
    }
    rerender({ sessionId: 'home-session' })
    catalog.bots = []
    rerender({ sessionId: 'home-session' })
    expect(result.current).toBeNull()
  })
  it('never uses the local catalog for another runtime or an SSH folder twin', () => {
    seed()
    const { result, rerender } = renderHook(
      ({ remote }) =>
        useBotChatIdentity(
          'folder:home',
          'home-session',
          remote ? { kind: 'environment', environmentId: 'server' } : { kind: 'local' }
        ),
      { initialProps: { remote: true } }
    )
    expect(result.current).toBeNull()
    act(() =>
      useAppStore.setState({
        folderWorkspaces: [makeFolderWorkspace({ id: 'home', executionHostId: 'ssh:server' })]
      })
    )
    rerender({ remote: false })
    expect(result.current).toBeNull()
  })
})

it('uses only the selected local folder link for an external thread', () => {
  const bot = seed()
  const { result } = renderHook(() =>
    useBotChatIdentity('folder:home', 'thread', { kind: 'local' })
  )
  expect(result.current).toBeNull()
  const link: ExternalConversationLink = {
    source: 'slack',
    externalId: 'thread',
    sessionId: 'thread',
    agent: 'codex',
    paneKey: 'thread',
    bot: { kind: 'bot', botId: bot.id },
    createdAt: 1
  }
  function setLink(externalLink: ExternalConversationLink) {
    act(() =>
      useAppStore.setState({
        folderWorkspaces: [
          makeFolderWorkspace({
            id: 'home',
            executionHostId: 'local',
            externalConversations: [externalLink]
          })
        ]
      })
    )
  }

  setLink(link)
  expect(result.current).toBe(bot)
  for (const other of [
    { ...link, bot: undefined },
    { ...link, bot: { kind: 'bot', botId: 'deleted-bot' } } as const,
    { ...link, sessionId: 'another-session' }
  ]) {
    setLink(other)
    expect(result.current).toBeNull()
  }
})
