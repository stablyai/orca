import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/agent-session/agent-session-runtime-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

export const NEW_TAB_TWIN_HOSTS = ['local', 'runtime:paired'] as const

export const NEW_TAB_PAIRED_STATUS: RuntimeEnvironmentStatus = {
  checkedAt: 1,
  status: {
    runtimeId: 'paired-runtime',
    capabilities: [CHAT, CLIENT, CATALOG],
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

export function newTabTwinHostWorkspaces(worktreeId: string) {
  return {
    worktreesByRepo: {
      [TEST_REPO.id]: NEW_TAB_TWIN_HOSTS.map((hostId) =>
        makeWorktree({ id: worktreeId, repoId: TEST_REPO.id, hostId, path: '/work/twins' })
      )
    },
    folderWorkspaces: NEW_TAB_TWIN_HOSTS.map((executionHostId) =>
      makeFolderWorkspace({ id: 'twins', executionHostId, folderPath: '/work/twins' })
    )
  }
}
