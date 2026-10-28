import { describe, expect, it } from 'vitest'
import { decodeWorkspaceViews } from './workspace-view-storage'

const panel = {
  id: 'p',
  workspaceId: 'w',
  tabId: 't',
  executionHostId: 'local',
  title: 'Shell',
  workspaceName: 'main',
  projectName: 'Project'
}
const view = {
  id: 'v',
  name: 'Daily',
  panels: [panel],
  layout: { type: 'leaf', groupId: 'p' },
  focusedPanelId: 'p'
}

describe('saved view recovery', () => {
  it('keeps missing-workspace references so the UI can show an honest placeholder', () => {
    expect(decodeWorkspaceViews({ version: 1, activeId: 'v', views: [view] })).toMatchObject({
      activeId: 'v',
      views: [{ panels: [panel], focusedPanelId: 'p' }]
    })
  })
  it('rejects invalid hosts and duplicate terminal placements rather than silently rebinding them', () => {
    const result = decodeWorkspaceViews({
      version: 1,
      activeId: 'v',
      views: [
        {
          ...view,
          panels: [
            panel,
            { ...panel, id: 'copy' },
            { ...panel, id: 'invalid', executionHostId: 'ssh:' }
          ]
        }
      ]
    })
    expect(result.views[0].panels).toEqual([panel])
  })
  it('reconstructs malformed or deeply nested layouts from the bounded panel list', () => {
    let layout: unknown = { type: 'leaf', groupId: 'foreign' }
    for (let depth = 0; depth < 50; depth++) {
      layout = { type: 'split', direction: 'horizontal', first: layout, second: view.layout }
    }
    expect(
      decodeWorkspaceViews({ version: 1, views: [{ ...view, layout }] }).views[0].layout
    ).toEqual(view.layout)
    expect(decodeWorkspaceViews({ version: 3, views: [view] })).toEqual({
      views: [],
      activeId: null
    })
  })
  it('does not restore a selected view that no longer exists', () => {
    expect(
      decodeWorkspaceViews({ version: 1, activeId: 'gone', views: [view] }).activeId
    ).toBeNull()
  })
})
