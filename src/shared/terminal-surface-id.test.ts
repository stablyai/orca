import { describe, expect, it } from 'vitest'
import { makePaneKey, parsePaneKey } from './stable-pane-id'
import {
  toHostSessionTabId,
  toScopedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from './terminal-surface-id'

describe('colliding terminal surface identities', () => {
  it.each(['tab::leaf', 'tab%00@host', '공유 탭'])('round trips %s through pane keys', (hostId) => {
    const id = toScopedWebTerminalSurfaceTabId(hostId, 'host:a', 'repo::C:\\worktree')
    expect(toHostSessionTabId(id)).toBe(hostId)
    const key = makePaneKey(id, '11111111-1111-4111-8111-111111111111')
    expect(parsePaneKey(key)?.tabId).toBe(id)
  })

  it('separates identical IDs across hosts and workspaces', () => {
    const ids = [
      toWebTerminalSurfaceTabId('shared'),
      toScopedWebTerminalSurfaceTabId('shared', 'a', 'folder:same'),
      toScopedWebTerminalSurfaceTabId('shared', 'b', 'folder:same'),
      toScopedWebTerminalSurfaceTabId('shared', 'a', 'folder:other')
    ]
    expect(new Set(ids).size).toBe(4)
    expect(ids.map(toHostSessionTabId)).toEqual(['shared', 'shared', 'shared', 'shared'])
  })

  it.each(['web-terminal-%00invalid', 'web-terminal-%00%5B1%2C2%2C3%5D'])(
    'keeps malformed scoped IDs intact: %s',
    (id) => expect(toHostSessionTabId(id)).toBe(id)
  )
})
