// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useNativeChatComposerMentions } from '../native-chat/native-chat-composer-room'
import { useBotChatComposerRoom } from './use-bot-chat-composer-room'
import { useBotGroupComposerRoom } from './use-bot-group-composer-room'

const catalog = vi.hoisted((): { bots: Bot[] } => ({ bots: [] }))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: (enabled = true) => (enabled ? catalog.bots : []),
  useBotsEnabled: () => true
}))
vi.mock('./bot-workspace', () => ({ useBotForWorkspace: () => null }))
vi.mock('./BotAvatar', () => ({ BotAvatar: () => null }))
vi.mock('./BotGroupReplyPicker', () => ({ BotGroupReplyPicker: () => null }))
vi.mock('./use-bot-purposes', () => ({
  useKnownBotPurposes: () => new Map(),
  refreshBotPurposes: () => {}
}))
vi.mock('../native-chat/composer/pickers/use-native-chat-mention-files', () => ({
  useNativeChatMentionFiles: () => ({ files: [], loading: false, failed: false })
}))

function bot(id: string, name: string): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: 'reviewer',
    folderWorkspaceId: `folder-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: null,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const GROUP: BotGroup = {
  id: 'group',
  name: 'Review',
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: catalogs stamp the owning host over the stored local schema.
  hostId: 'runtime:m4' as BotGroup['hostId'],
  revision: 1,
  folder: 'review',
  folderWorkspaceId: 'group-folder',
  createdAt: 1,
  members: [
    { botId: 'same', sessionId: 'member' },
    { botId: 'zebra', sessionId: 'other' }
  ],
  replyMode: { kind: 'mentions' }
}

beforeEach(() => {
  catalog.bots = [
    bot('same', 'Local twin'),
    stampBotHost('runtime:m4', bot('same', 'Remote reviewer')),
    stampBotHost('runtime:m4', bot('zebra', 'Zebra'))
  ]
  localStorage.clear()
})
afterEach(cleanup)

it('lists only the group members on its owning host', () => {
  const { result } = renderHook(() =>
    useBotGroupComposerRoom('group-draft', GROUP, catalog.bots, () => {})
  )
  expect(result.current.room?.mentions.map((member) => member.name)).toEqual([
    'Remote reviewer',
    'Zebra',
    'everyone'
  ])
})

it.each(['group', 'chat'] as const)(
  'carries a %s pick across chat kinds and a rename without duplicate Recent entries',
  (source) => {
    const { result, rerender } = renderHook(() => {
      const group = useBotGroupComposerRoom('group-draft', GROUP, catalog.bots, () => {}).room
      const chat = useBotChatComposerRoom('workspace', 'runtime:m4')
      const autocomplete: ComposerAutocomplete = { mode: 'mention', query: '', triggerKey: '@:0' }
      const picker = { autocomplete, completeMention: () => {} }
      const files = { terminalTabId: 'tab', structuredWorktreeId: undefined }
      return {
        group: useNativeChatComposerMentions(group, '@', picker, files),
        chat: useNativeChatComposerMentions(chat, '@', picker, files)
      }
    })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'orca.nativeChat.recentMentions' }))
    })
    const target = source === 'group' ? 'chat' : 'group'
    const remoteKey = 'runtime:m4\u0000same'
    act(() =>
      result.current[source].chooseMention(source === 'chat' ? remoteKey : 'Remote reviewer')
    )
    expect(result.current[target].roomContext?.recentCount).toBe(1)
    catalog.bots = catalog.bots.map((entry) =>
      entry.hostId === GROUP.hostId && entry.id === 'same'
        ? { ...entry, name: 'Renamed reviewer' }
        : entry
    )
    rerender()
    const renamedValue = target === 'chat' ? remoteKey : 'Renamed reviewer'
    expect(result.current[target].mentionFiles.files[0]).toBe(renamedValue)
    expect(result.current[target].roomContext?.matches?.[0]?.name).toBe('Renamed reviewer')
    expect(result.current[target].roomContext?.recentCount).toBe(1)
    act(() => result.current[target].chooseMention(renamedValue))
    expect(result.current[source].roomContext?.recentCount).toBe(1)
    expect(JSON.parse(localStorage.getItem('orca.nativeChat.recentMentions')!)).toEqual([
      'runtime:m4\u0000same'
    ])
  }
)
