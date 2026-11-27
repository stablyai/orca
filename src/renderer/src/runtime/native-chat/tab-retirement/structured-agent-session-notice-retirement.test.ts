// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
const host = vi.hoisted((): { close: Promise<boolean>; tabs: Record<string, Tab[]> } => ({
  close: Promise.resolve(true),
  tabs: {}
}))
vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: host.tabs }) }
}))
vi.mock('./structured-agent-session-host-tab-retirement', () => ({
  retireStructuredAgentSessionTab: () => host.close
}))
vi.mock('../../local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => ({ tabs: [] })
}))
const { beginStructuredAgentSessionTabClose } =
  await import('./structured-agent-session-tab-retirement')
const {
  noteNativeChatFilesHeldElsewhere,
  readNativeChatHeldElsewhere,
  nativeChatHeldElsewhereRecordCountForTests
} = await import('@/components/native-chat/composer/controls/native-chat-held-elsewhere-notice')

const layoutOwner = {
  unifiedTabsByWorktree: {},
  groupsByWorktree: {},
  reorderUnifiedTabs: () => {}
}
const close = (sessionId: string) =>
  beginStructuredAgentSessionTabClose({
    target: { kind: 'local' },
    worktreeId: 'wt',
    sessionId,
    provisional: false,
    layoutOwner
  })

it('retires published notices after successful close including a refusal arriving before its reply', async () => {
  const initial = nativeChatHeldElsewhereRecordCountForTests()
  host.tabs = {}
  for (let index = 0; index < 20; index += 1) {
    const sessionId = `published-close-${index}`
    const result = Promise.withResolvers<boolean>()
    host.close = result.promise
    close(sessionId)
    noteNativeChatFilesHeldElsewhere(sessionId, ['blob:late-refusal'])
    expect(readNativeChatHeldElsewhere(sessionId)).not.toBeNull()
    result.resolve(true)
    await result.promise
    await Promise.resolve()
    expect(readNativeChatHeldElsewhere(sessionId)).toBeNull()
  }
  expect(nativeChatHeldElsewhereRecordCountForTests()).toBe(initial)
})

it('keeps a failed close and a surviving paired conversation account', async () => {
  host.tabs = {}
  host.close = Promise.resolve(false)
  noteNativeChatFilesHeldElsewhere('failed-close', ['blob:kept'])
  close('failed-close')
  await host.close
  await Promise.resolve()
  expect(readNativeChatHeldElsewhere('failed-close')).not.toBeNull()
  host.tabs = {
    paired: [
      {
        id: 'paired',
        entityId: 'surviving-close',
        contentType: 'agent-session',
        worktreeId: 'paired',
        executionHostId: 'ssh:paired',
        groupId: 'g',
        label: 'Paired',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  host.close = Promise.resolve(true)
  noteNativeChatFilesHeldElsewhere('surviving-close', ['blob:kept'])
  close('surviving-close')
  await host.close
  await Promise.resolve()
  expect(readNativeChatHeldElsewhere('surviving-close')).not.toBeNull()
})
