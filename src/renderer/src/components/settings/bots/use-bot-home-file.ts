import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getDiskBaselineSignature } from '../../../../../shared/file-write/disk-baseline-signature'
import { isConfirmedFileNotFoundError } from '../../../../../shared/file-write/file-write-disk-precondition'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import type { Bot } from '../../../../../shared/bot-types'
import { type BotHome, readBotHomeFile, writeBotHomeFile } from './bot-home-files'
import { botHomeHostId } from '../../../../../shared/bots/bot-home-host'

export type BotHomeFileWrite = 'saved' | 'changed-on-disk' | 'failed'

export type BotHomeFile = {
  /** What is on disk as last read or written; null until the first read. */
  disk: string | null
  readError: string | null
  /** Re-reads the file; the bot may have changed it. */
  refresh: () => Promise<void>
  /** Writes `next` only if disk still holds `base`; otherwise re-reads and reports the change. Writes run in order. */
  write: (next: string, base: string) => Promise<BotHomeFileWrite>
}

async function readText(home: BotHome, relativePath: string): Promise<string> {
  try {
    return await readBotHomeFile(home, relativePath)
  } catch (error) {
    // A file the bot deleted reads as empty and is written back on save.
    if (isConfirmedFileNotFoundError(error)) {
      return ''
    }
    throw error
  }
}

/** One home, kept while its host, workspace and folder stay the same. */
export function useStableBotHome(home: BotHome): BotHome
export function useStableBotHome(home: BotHome | null): BotHome | null
export function useStableBotHome(home: BotHome | null): BotHome | null {
  const hostId = home?.bot.hostId
  const folderWorkspaceId = home?.bot.folderWorkspaceId
  const folderPath = home?.folderPath
  return useMemo(
    () =>
      hostId === undefined || folderWorkspaceId === undefined || folderPath === undefined
        ? null
        : { bot: { hostId, folderWorkspaceId }, folderPath },
    [hostId, folderWorkspaceId, folderPath]
  )
}

/** The bot's home as its catalog lists it; null while its folder workspace isn't loaded. */
export function useBotHome(bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'> | null): BotHome | null {
  const folderPath = useAppStore((state) =>
    // A home kept on this computer for another account's agent holds none of that agent's files.
    bot && botHomeHostId(bot) === bot.hostId
      ? (selectFolderWorkspaceOnHost(state, bot.folderWorkspaceId, bot.hostId)?.folderPath ?? null)
      : null
  )
  return useStableBotHome(bot && folderPath ? { bot, folderPath } : null)
}

/** One file in a bot's home, read on the bot's host and again whenever Orca regains focus. */
export function useBotHomeFile(listedHome: BotHome, relativePath: string): BotHomeFile {
  const home = useStableBotHome(listedHome)
  const [disk, setDisk] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  // Bumped by every read and write, so only the newest read can set the text.
  const generation = useRef(0)
  const writes = useRef<Promise<unknown>>(Promise.resolve())

  const refresh = useCallback(async () => {
    const startedAt = ++generation.current
    try {
      const text = await readText(home, relativePath)
      if (startedAt === generation.current) {
        setDisk(text)
        setReadError(null)
      }
    } catch (error) {
      setReadError(error instanceof Error ? error.message : String(error))
    }
  }, [home, relativePath])

  useEffect(() => {
    void refresh()
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const write = useCallback(
    (next: string, base: string): Promise<BotHomeFileWrite> => {
      const run = async (): Promise<BotHomeFileWrite> => {
        generation.current += 1
        try {
          const result = await writeBotHomeFile(home, relativePath, next, {
            expectedSignature: getDiskBaselineSignature(base),
            allowMissing: base === ''
          })
          generation.current += 1
          if (result.ok) {
            setDisk(next)
            return 'saved'
          }
          await refresh()
          return 'changed-on-disk'
        } catch (error) {
          toast.error(translate('settings.bots.fileSaveFailed', "Couldn't save the file"), {
            description: error instanceof Error ? error.message : String(error)
          })
          return 'failed'
        }
      }
      const result = writes.current.then(run)
      writes.current = result
      return result
    },
    [home, relativePath, refresh]
  )

  return { disk, readError, refresh, write }
}
