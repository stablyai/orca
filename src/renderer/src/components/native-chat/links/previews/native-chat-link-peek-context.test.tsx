import { useContext } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import {
  resolveNativeChatFileLinkContextForOwner,
  type NativeChatFileLinkState
} from '../actions/native-chat-file-link-context'
import {
  NativeChatLinkPeekContext,
  NativeChatLinkPeekProvider
} from './native-chat-link-peek-context'

const mocks = vi.hoisted((): { state: NativeChatFileLinkState | null } => ({ state: null }))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: NativeChatFileLinkState) => unknown) => select(mocks.state!)
}))

function RoutingHost() {
  return useContext(NativeChatLinkPeekContext).githubRoutingAuthorityKey
}

it.each([
  { owner: {}, runtimeEnvironmentId: null, expectedHost: 'local' },
  { owner: { connectionId: 'box' }, runtimeEnvironmentId: null, expectedHost: 'ssh:box' },
  {
    owner: { executionHostId: 'runtime:env' as const },
    runtimeEnvironmentId: 'env',
    expectedHost: 'runtime:env'
  },
  {
    owner: { executionHostId: 'runtime:env' as const, connectionId: 'T' },
    runtimeEnvironmentId: 'env',
    expectedHost: 'nested:env/T'
  }
])(
  'routes a folder chat preview through $expectedHost',
  ({ owner, runtimeEnvironmentId, expectedHost }) => {
    const folder: FolderWorkspace = {
      id: 'chat',
      projectGroupId: 'group',
      name: 'Chat',
      folderPath: '/workspace',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0,
      ...owner
    }
    mocks.state = {
      repos: [],
      projectGroups: [],
      folderWorkspaces: [folder],
      settings: null,
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      tabsByWorktree: {},
      floatingWorkspacePath: null
    }
    const context = resolveNativeChatFileLinkContextForOwner(mocks.state, 'tab', 'folder:chat')
    expect(context?.runtimeEnvironmentId).toBe(runtimeEnvironmentId)
    expect(
      renderToStaticMarkup(
        <NativeChatLinkPeekProvider fileLinkContext={context}>
          <RoutingHost />
        </NativeChatLinkPeekProvider>
      )
    ).toBe(expectedHost)
  }
)
