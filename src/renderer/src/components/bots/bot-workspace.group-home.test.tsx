// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useBotGroupForWorkspace } from './bot-workspace'

const fixtures = vi.hoisted(() => ({
  groups: [{ id: 'group-1', name: 'Room', folderWorkspaceId: 'room-home' }],
  bots: [{ id: 'bot-1', folderWorkspaceId: 'bot-home' }]
}))

vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => fixtures.bots,
  readBotsEnabled: () => true,
  useBots: () => fixtures.bots,
  useBotsEnabled: () => true
}))
vi.mock('@/lib/bot-group-list', () => ({
  useBotGroups: (enabled = true) => (enabled ? fixtures.groups : [])
}))

it("finds a group by its home workspace, and nothing for a plain folder or a bot's home", () => {
  const lookup = (workspaceId: string | null) =>
    renderHook(() => useBotGroupForWorkspace(workspaceId)).result.current?.id ?? null
  expect(lookup('folder:room-home')).toBe('group-1')
  expect(lookup('folder:bot-home')).toBeNull()
  expect(lookup('folder:projects')).toBeNull()
  expect(lookup(null)).toBeNull()
})
