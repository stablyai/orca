import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatTranscriptScope } from '../native-chat/native-chat-transcript-scope'
import { createNativeChatFileLinkExistence } from '../native-chat/links/actions/native-chat-file-link-existence'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatFileLinkContext } from '../native-chat/links/actions/native-chat-file-link-context'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'

type GroupFileContext = {
  fileLinkContext: NativeChatFileLinkContext
  runtimeContext: RuntimeFileOperationArgs
  existence: ReturnType<typeof createNativeChatFileLinkExistence>
}
type FileOwner = { id: string; folderWorkspaceId: string }

/** Keyed by owner id: each member bot's folder, and the room's own home for owner messages, all on
 *  the room's host. Paths resolve in the writer's folder; every open lands in the room's home, beside the chat. */
export function useBotGroupFileContexts(
  bots: readonly FileOwner[],
  room: (FileOwner & BotOnHost) | undefined,
  tabId: string
) {
  const folders = useAppStore(selectFolderWorkspaces)
  const cache = useMemo(() => new Map<string, GroupFileContext>(), [])
  return useMemo(() => {
    const result = new Map<string, GroupFileContext>()
    const hostId = room?.hostId
    const target = room ? botTarget(room) : null
    const hostFolders = new Map(
      folders
        .filter((folder) => !folder.connectionId && getRepoExecutionHostId(folder) === hostId)
        .map((folder) => [folder.id, folder])
    )
    const home = room && hostFolders.get(room.folderWorkspaceId)
    for (const owner of home && target ? [...bots, room] : []) {
      const folder = hostFolders.get(owner.folderWorkspaceId)
      if (!home || !folder || !target) {
        continue
      }
      const worktreeId = folderWorkspaceKey(folder.id)
      const fileLinkContext: NativeChatFileLinkContext = {
        worktreeId: folderWorkspaceKey(home.id),
        worktreePath: home.folderPath,
        runtimeEnvironmentId: runtimeTargetEnvironmentId(target),
        sourceTabId: tabId,
        ...(folder.id === home.id ? {} : { pathBase: folder.folderPath })
      }
      let context = cache.get(owner.id)
      if (
        !context ||
        context.runtimeContext.target !== target ||
        context.runtimeContext.worktreeId !== worktreeId ||
        context.runtimeContext.worktreePath !== folder.folderPath ||
        context.fileLinkContext.worktreeId !== fileLinkContext.worktreeId ||
        context.fileLinkContext.worktreePath !== fileLinkContext.worktreePath ||
        context.fileLinkContext.sourceTabId !== tabId
      ) {
        context = {
          fileLinkContext,
          runtimeContext: {
            target,
            worktreeId,
            worktreePath: folder.folderPath,
            ...(hostId === LOCAL_EXECUTION_HOST_ID ? { expectedExecutionHostId: hostId } : {})
          },
          existence: createNativeChatFileLinkExistence({
            cwd: folder.folderPath,
            worktreeId,
            worktreePath: folder.folderPath,
            runtimeEnvironmentId: runtimeTargetEnvironmentId(target),
            connectionId: null
          })
        }
        cache.set(owner.id, context)
      }
      result.set(owner.id, context)
    }
    for (const id of cache.keys()) {
      if (!result.has(id)) {
        cache.delete(id)
      }
    }
    return result
  }, [bots, room, folders, tabId, cache])
}

export function BotGroupTranscriptOwner({
  context,
  sessionId,
  tabId,
  isVisible,
  children
}: {
  context: GroupFileContext | null
  sessionId: string | null
  tabId: string
  isVisible: boolean
  children: ReactNode
}) {
  const visualOwner = useMemo(
    () =>
      context && sessionId
        ? {
            target: context.runtimeContext.target,
            sessionId,
            tabId,
            worktreeId: context.fileLinkContext.worktreeId
          }
        : null,
    [context, sessionId, tabId]
  )
  const image = useMemo(
    () => ({
      fileLinkContext: context?.fileLinkContext ?? null,
      runtimeContext: context?.runtimeContext ?? null,
      sessionId,
      isVisible
    }),
    [context, sessionId, isVisible]
  )
  return (
    <NativeChatTranscriptScope
      value={{ visualOwner, image, existence: context?.existence ?? null }}
    >
      {children}
    </NativeChatTranscriptScope>
  )
}
