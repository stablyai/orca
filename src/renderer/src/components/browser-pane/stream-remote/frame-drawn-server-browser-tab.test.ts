import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY } from '../../../../../shared/browser-runtime-capabilities'
import {
  resetFrameDrawnServerWorkspacesForTests,
  setFrameDrawnServerWorkspaces
} from '@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces'
import { frameDrawnServerBrowserTab } from './frame-drawn-server-browser-tab'

const TAB = { environmentId: 'env-1', worktreeId: 'wt-1', browserTabId: 'tab-1' }

afterEach(() => resetFrameDrawnServerWorkspacesForTests())

describe('frameDrawnServerBrowserTab', () => {
  it('names the tab in a workspace the server frames draw, with the host page-id support', () => {
    setFrameDrawnServerWorkspaces('env-1', new Set(['wt-1']))

    expect(
      frameDrawnServerBrowserTab({
        ...TAB,
        capabilities: [BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY]
      })
    ).toEqual({ browserTabId: 'tab-1', hostKnowsPageIds: true })
    expect(frameDrawnServerBrowserTab({ ...TAB, capabilities: [] })).toEqual({
      browserTabId: 'tab-1',
      hostKnowsPageIds: false
    })
  })

  it('names nothing for a workspace no server frames draw', () => {
    setFrameDrawnServerWorkspaces('env-1', new Set(['wt-other']))

    expect(frameDrawnServerBrowserTab({ ...TAB, capabilities: [] })).toBeNull()
  })
})
