import { createContext } from 'react'
import { isWorktreeConnectionResolved } from '@/lib/workspace/ownership/connection-context'
import { createTerminalPathExistenceBatch } from '@/components/terminal-pane/links/files/terminal-path-existence-batch'
import {
  mayCheckFileLinkTargetUnprompted,
  resolveFileLinkTarget,
  type FileLinkHost,
  type FileLinkPathExistence,
  type FileLinkTarget
} from '@/components/terminal-pane/links/files/terminal-file-link-target'
import { getTerminalFileContext } from '@/components/terminal-pane/host-files/terminal-file-path-mapping'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  createNativeChatFileLinkChecker,
  type NativeChatFileLinkExistence
} from '../../../../../../shared/native-chat/native-chat-file-link-existence'

export const NativeChatFileLinkExistenceContext = createContext<NativeChatFileLinkExistence | null>(
  null
)

export type NativeChatFileLinkHost = FileLinkHost & {
  /** The workspace's SSH connection; undefined while the store cannot name its host yet. */
  connectionId: string | null | undefined
}

export function createNativeChatFileLinkExistence(
  host: NativeChatFileLinkHost,
  pathExists: FileLinkPathExistence = createTerminalPathExistenceBatch()
): NativeChatFileLinkExistence {
  // Why: until an SSH workspace's connection is known, an unrouted check would stat this machine (#6648).
  const hostUnresolved =
    host.connectionId === undefined && !isWorktreeConnectionResolved(host.worktreeId)
  const isHostUnresolved = (target: FileLinkTarget): boolean =>
    !target.fileContext.sourceHostResolved ||
    (hostUnresolved && !target.fileContext.connectionId && !target.isRemoteRuntimePath)

  return createNativeChatFileLinkChecker<FileLinkTarget>({
    lookup: (link) => {
      const target = resolveFileLinkTarget(link, host)
      if (target?.isKnownWorktreeRoot) {
        return { kind: 'linked' }
      }
      // Why: chat checks without a click, so a network share outside the workspace is never asked about.
      if (!target || isHostUnresolved(target) || !mayCheckFileLinkTargetUnprompted(target, host)) {
        return { kind: 'plain' }
      }
      return { kind: 'ask', key: target.cacheKey, target }
    },
    ask: async (target) => {
      // Held targets can become ambiguous or move hosts; recheck ownership before each retry.
      const current = getTerminalFileContext(
        host.worktreeId,
        host.worktreePath,
        host.runtimeEnvironmentId
      )
      if (
        !current.sourceHostResolved ||
        current.connectionId !== target.fileContext.connectionId ||
        runtimeTargetEnvironmentId(current.target) !==
          runtimeTargetEnvironmentId(target.fileContext.target)
      ) {
        throw new Error('The workspace host changed or could not be determined')
      }
      return pathExists(target.fileContext, target.absolutePath, target.isRemoteRuntimePath)
    }
  })
}
