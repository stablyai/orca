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
      { type: 'snapshot', subscriptionId: 'layout-1', workspaces: [{ key: GIT_KEY, layout }] },
      { type: 'workspace', key: GIT_KEY, layout },
      { type: 'removed', key: GIT_KEY },
      { type: 'end' }
    ]
    for (const frame of frames) {
      expect(readWorkspaceLayoutStreamFrame(frame)).toEqual(frame)
    }
  })

  it('returns null for a newer host’s frame type and for malformed frames', () => {
    const layout = publishedLayout()
    expect(readWorkspaceLayoutStreamFrame({ type: 'navigate', request: {} })).toBeNull()
    expect(readWorkspaceLayoutStreamFrame(null)).toBeNull()
    expect(readWorkspaceLayoutStreamFrame({ type: 'workspace', key: '', layout })).toBeNull()
    expect(readWorkspaceLayoutStreamFrame({ type: 'workspace', key: 'a', layout: {} })).toBeNull()
    expect(
      readWorkspaceLayoutStreamFrame({
        type: 'snapshot',
        subscriptionId: 'layout-1',
        workspaces: [{ key: 'a', layout: { worktreeId: 'a' } }]
      })
    ).toBeNull()
  })
})
