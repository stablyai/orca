// Files in a bot's home folder, read and written on the computer that runs the bot.
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { readRuntimeFileContent } from '@/runtime/files/reads/runtime-file-read-client'
import { readRuntimeDirectory } from '@/runtime/files/reads/runtime-directory-read'
import { writeRuntimeFile } from '@/runtime/files/mutations/runtime-file-mutation-client'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { DirEntry } from '../../../../../shared/file-listing/directory-entry'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../../../shared/file-write/file-write-disk-precondition'
import { resolveRuntimePath } from '../../../../../shared/file-access/cross-platform-path'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

/** A bot's home: its host and folder workspace, and the folder's path on that host. */
export type BotHome = {
  bot: BotOnHost & { folderWorkspaceId: string }
  folderPath: string
}

function homeContext({ bot, folderPath }: BotHome): RuntimeFileOperationArgs {
  return {
    target: botTarget(bot),
    worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
    worktreePath: folderPath
  }
}

/** A stable key for caches about one home. */
export function botHomeKey({ bot, folderPath }: BotHome): string {
  return `${bot.hostId}\u0000${folderPath}`
}

export function botHomePath(home: BotHome, relativePath: string): string {
  return resolveRuntimePath(home.folderPath, relativePath)
}

export async function readBotHomeFile(home: BotHome, relativePath: string): Promise<string> {
  const context = homeContext(home)
  const read = await readRuntimeFileContent({
    target: context.target,
    worktreeId: context.worktreeId ?? undefined,
    filePath: botHomePath(home, relativePath),
    relativePath
  })
  return read.content
}

/** A save this window made to a file in a bot's home. */
export type BotHomeFileSaved = { home: BotHome; relativePath: string; content: string }

const saveListeners = new Set<(saved: BotHomeFileSaved) => void>()

/** Hears each save to a bot's home file made here, so whatever shows that file updates at once. */
export function subscribeToBotHomeFileSaves(
  listener: (saved: BotHomeFileSaved) => void
): () => void {
  saveListeners.add(listener)
  return () => saveListeners.delete(listener)
}

export async function writeBotHomeFile(
  home: BotHome,
  relativePath: string,
  content: string,
  diskPrecondition: FileWriteDiskPrecondition
): Promise<FileWriteResult> {
  const result = await writeRuntimeFile(
    homeContext(home),
    botHomePath(home, relativePath),
    content,
    undefined,
    diskPrecondition
  )
  if (result.ok) {
    saveListeners.forEach((listener) => listener({ home, relativePath, content }))
  }
  return result
}

export function readBotHomeDir(home: BotHome, relativePath: string): Promise<DirEntry[]> {
  return readRuntimeDirectory(homeContext(home), botHomePath(home, relativePath))
}
