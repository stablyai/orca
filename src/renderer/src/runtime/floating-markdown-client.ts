import { floatingWorkspaceEnvironmentId } from '../../../shared/floating-workspace-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeMarkdownReadTabResult } from '../../../shared/mobile-markdown-document'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getRuntimeEnvironmentRevision } from './runtime-environment-revision'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import type { RuntimeFileReadArgs } from './runtime-file-client-types'

export function assertFloatingFileOwner(
  args: Pick<RuntimeFileReadArgs, 'settings' | 'worktreeId'>
): void {
  const environmentId = floatingWorkspaceEnvironmentId(args.worktreeId)
  if (environmentId && args.settings?.activeRuntimeEnvironmentId !== environmentId) {
    throw new Error('Floating file host does not match its owning runtime')
  }
}

// Older hosts expose floating documents through session tabs, but not files.read.
export async function readFloatingMarkdownTab(
  args: Pick<RuntimeFileReadArgs, 'settings' | 'worktreeId' | 'filePath'>
): Promise<{
  document: RuntimeMarkdownReadTabResult
  save: (content: string) => Promise<void>
} | null> {
  assertFloatingFileOwner(args)
  const worktreeId = args.worktreeId
  const environmentId = floatingWorkspaceEnvironmentId(worktreeId)
  if (!worktreeId || !environmentId) {
    return null
  }
  const target = { kind: 'environment' as const, environmentId }
  const options = {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
  }
  const worktree = toRuntimeWorktreeSelector(worktreeId)
  const snapshot = await callRuntimeRpc<RuntimeMobileSessionTabsResult>(
    target,
    'session.tabs.list',
    { worktree },
    options
  )
  const candidates = snapshot.tabs.filter(
    (candidate) => candidate.type === 'markdown' && candidate.filePath === args.filePath
  )
  const tab =
    candidates.find((candidate) => candidate.type === 'markdown' && candidate.mode === 'edit') ??
    candidates[0]
  if (!tab) {
    return null
  }
  const document = await callRuntimeRpc<RuntimeMarkdownReadTabResult>(
    target,
    'markdown.readTab',
    { worktree, tabId: tab.id },
    options
  )
  if (document.tabId !== tab.id || document.filePath !== args.filePath) {
    throw new Error('Remote document identity changed. Reopen the file.')
  }
  if (document.truncated) {
    throw new Error(`Remote file is too large to open in the editor (${document.byteLength} bytes)`)
  }
  return {
    document,
    save: async (content) => {
      if (!document.editable) {
        throw new Error(document.readOnlyReason ?? 'Remote document is read-only')
      }
      await callRuntimeRpc(
        target,
        'markdown.saveTab',
        { worktree, tabId: tab.id, baseVersion: document.version, content },
        options
      )
    }
  }
}
