import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { localDesktopSession } from './workspace-layout-profile.test-fixture'
import { publishWorkspaceLayout } from './workspace-layout-published'
import { GIT_KEY } from './workspace-layout-session.test-fixture'
import { readWorkspaceLayoutStreamFrame } from './workspace-layout-stream-frames'

function publishedLayout() {
  const { layout } = loadWorkspaceLayout(
    LOCAL_EXECUTION_HOST_ID,
    localDesktopSession(),
    nameBasedLoadContext()
  )
  return publishWorkspaceLayout(layout.workspaces[GIT_KEY]!, LOCAL_EXECUTION_HOST_ID)
}

describe('readWorkspaceLayoutStreamFrame', () => {
  it('reads every frame the runtime sends, through the wire encoding', () => {
    const layout = JSON.parse(JSON.stringify(publishedLayout()))
    const frames = [
      { type: 'workspace', key: GIT_KEY, layout },
      { type: 'snapshot', workspaces: [{ key: GIT_KEY, layout }] },
      { type: 'removed', key: GIT_KEY },
      { type: 'end' }
    ]
    for (const frame of frames) {
      expect(readWorkspaceLayoutStreamFrame(frame)).toEqual(frame)
    }
    expect(
      readWorkspaceLayoutStreamFrame({
        type: 'snapshot',
        subscriptionId: 'layout-1',
        workspaces: [{ key: GIT_KEY, layout }]
      })
    ).toEqual({ type: 'snapshot', workspaces: [{ key: GIT_KEY, layout }] })
  })

  it('keeps a frame’s stream position, and drops one that is not a position', () => {
    const layout = publishedLayout()
    expect(
      readWorkspaceLayoutStreamFrame({ type: 'workspace', key: GIT_KEY, layout, seq: 7 })
    ).toEqual({ type: 'workspace', key: GIT_KEY, layout, seq: 7 })
    expect(readWorkspaceLayoutStreamFrame({ type: 'removed', key: GIT_KEY, seq: 0 })).toEqual({
      type: 'removed',
      key: GIT_KEY,
      seq: 0
    })
    expect(readWorkspaceLayoutStreamFrame({ type: 'snapshot', workspaces: [], seq: 3 })).toEqual({
      type: 'snapshot',
      workspaces: [],
      seq: 3
    })
    for (const seq of [-1, 1.5, '4', null, Number.MAX_VALUE]) {
      expect(readWorkspaceLayoutStreamFrame({ type: 'removed', key: GIT_KEY, seq })).toEqual({
        type: 'removed',
        key: GIT_KEY
      })
    }
  })

  it('returns null for a newer host’s frame type and for malformed frames', () => {
    const layout = publishedLayout()
    for (const unreadable of [
      { type: 'navigate', request: {} },
      null,
      { type: 'workspace', key: '', layout },
      { type: 'workspace', key: 'a', layout: {} },
      { type: 'removed' },
      { type: 'snapshot', workspaces: [{ key: 'a', layout: { worktreeId: 'a' } }] }
    ]) {
      expect(readWorkspaceLayoutStreamFrame(unreadable)).toBeNull()
    }
  })
})
