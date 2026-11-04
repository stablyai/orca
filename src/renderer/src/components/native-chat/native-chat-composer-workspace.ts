import type { AppState } from '@/store/types'
import { workspaceTabs } from '@/lib/structured-chat-tab-index'
import { findIndexedRepoOwnerForHost } from '@/lib/repo-owner-index'
import { getKnownExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  selectWorktreesByRepo,
  selectFolderWorkspaces,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  floatingWorkspaceToWorktree,
  isFloatingWorkspaceId
} from '../../../../shared/floating-workspace-worktree'
import {
  createNativeChatTabOwnerSelector,
  FILE_LINK_CONTEXT_INPUT_KEYS
} from './native-chat-file-link'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type NativeChatComposerWorkspaceTarget = Pick<
  NativeChatStructuredComposerTransport,
  'worktreeId' | 'runtimeEnvironmentId'
>

export function createNativeChatComposerWorkspaceSelector(
  tabId: string,
  target?: NativeChatComposerWorkspaceTarget
) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  let unifiedBucket: ReturnType<typeof workspaceTabs>
  let tabHost: ExecutionHostId | undefined
  let inputs: unknown[] | undefined
  let presentation: {
    project?: string
    checkout?: string
    path?: string
    branch?: string
    head?: string
    mainCheckout?: boolean
  } = {}
  return (state: AppState) => {
    const worktreeId = target?.worktreeId ?? selectOwner(state)
    const unified = worktreeId ? workspaceTabs(state.unifiedTabsByWorktree, worktreeId) : undefined
    if (unifiedBucket !== unified) {
      tabHost = unified?.find((tab) => tab.id === tabId)?.executionHostId
      unifiedBucket = unified
    }
    // A structured transport's null environment positively identifies this host.
    const explicitHost = target
      ? target.runtimeEnvironmentId
        ? toRuntimeExecutionHostId(target.runtimeEnvironmentId)
        : 'local'
      : tabHost
    const catalog = {
      repos: state.repos,
      projectGroups: state.projectGroups,
      worktreesByRepo: selectWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state),
      detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state),
      floatingWorkspacePath: state.floatingWorkspacePath
    }
    const next = [
      worktreeId,
      explicitHost,
      unified,
      state.structuredSessionLaunchDirectoryByTabId[tabId],
      ...Object.values(catalog),
      // Global owner evidence matters only when this chat has no explicit host.
      ...(explicitHost ? [] : FILE_LINK_CONTEXT_INPUT_KEYS.map((key) => state[key]))
    ]
    if (!inputs || next.some((input, index) => input !== inputs?.[index])) {
      inputs = next
      const host = explicitHost ?? getKnownExecutionHostIdForWorktree(state, worktreeId)
      const path = worktreeId ? resolveNativeChatTabDirectory(state, tabId, worktreeId, host) : null
      const row =
        path && worktreeId
          ? isFloatingWorkspaceId(worktreeId)
            ? floatingWorkspaceToWorktree(path)
            : findKnownWorktreeById(catalog, worktreeId, host ?? undefined)
          : undefined
      presentation = {
        project: row
          ? findIndexedRepoOwnerForHost(state.repos, row.repoId, host ?? 'local')?.displayName
          : undefined,
        checkout: row?.displayName,
        mainCheckout: row?.isMainWorktree,
        path: path ?? undefined,
        branch: row?.branch,
        head: row?.head
      }
    }
    return presentation
  }
}
