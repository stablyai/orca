import { useEffect, useState } from 'react'
import { soulDescription } from '../../../../shared/bot-soul'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/autosave/editor-autosave'
import { editorSavedEventView } from '@/components/editor/save/commands/editor-saved-event-view'
import { botTarget } from '@/lib/bot-hosts'
import { useBotHostOffline } from '@/lib/bot-host-views'
import { isOpenFileOnMoveOwner } from '@/lib/editor/file-operations/open-editor-move-owner'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import {
  type BotHome,
  botHomeKey,
  botHomePath,
  readBotHomeFile,
  subscribeToBotHomeFileSaves
} from '../settings/bots/bot-home-files'
import { useStableBotHome } from '../settings/bots/use-bot-home-file'

/** The SOUL.md text an editor tab just saved, when that tab holds this home's SOUL.md on its host. */
function editorSavedSoul(home: BotHome, event: Event): string | null {
  const detail = event instanceof CustomEvent ? event.detail : null
  const state = useAppStore.getState()
  const file = editorSavedEventView(state.openFiles, detail)
  if (
    !file ||
    typeof detail?.content !== 'string' ||
    normalizeRuntimePathForComparison(file.filePath) !==
      normalizeRuntimePathForComparison(botHomePath(home, 'SOUL.md'))
  ) {
    return null
  }
  // The same path on another filesystem is another file: another paired server, or an SSH machine
  // reached from here or through the bot's own server. A bot's home is never on SSH.
  return isOpenFileOnMoveOwner(state, file, {
    runtimeEnvironmentId: runtimeTargetEnvironmentId(botTarget(home.bot)),
    sshHostId: null,
    worktreeId: folderWorkspaceKey(home.bot.folderWorkspaceId)
  })
    ? detail.content
    : null
}

/** Tickets for overlapping reads and saves: only the newest is current, and none once closed. */
function newestTicket(): {
  take: () => number
  isNewest: (ticket: number) => boolean
  close: () => void
} {
  let latest = 0
  let closed = false
  return {
    take: () => (latest += 1),
    isNewest: (ticket) => !closed && ticket === latest,
    close: () => {
      closed = true
    }
  }
}

/** The bot's description: the first paragraph of its SOUL.md, read on its host. It follows every
 *  save made here (Settings' Soul field or SOUL.md's editor tab), reads again when Orca regains
 *  focus (the bot or another app may have changed it), and when the host comes back. */
export function useBotSoulDescription(listedHome: BotHome | null): string | null {
  const [description, setDescription] = useState<string | null>(null)
  const home = useStableBotHome(listedHome)
  // A disconnected host can't be read; coming back reads again, so a read that failed while it was down recovers.
  const offline = useBotHostOffline(listedHome?.bot.hostId ?? 'local')
  useEffect(() => {
    if (!home || offline) {
      return
    }
    // Every read and save takes a ticket, so only the newest one sets the text.
    const tickets = newestTicket()
    const show = (content: string): void => {
      tickets.take()
      setDescription(soulDescription(content))
    }
    const read = (): void => {
      const ticket = tickets.take()
      readBotHomeFile(home, 'SOUL.md').then(
        (content) =>
          tickets.isNewest(ticket) ? setDescription(soulDescription(content)) : undefined,
        () => undefined
      )
    }
    const key = botHomeKey(home)
    const stopSaves = subscribeToBotHomeFileSaves((save) => {
      if (save.relativePath === 'SOUL.md' && botHomeKey(save.home) === key) {
        show(save.content)
      }
    })
    const onEditorSaved = (event: Event): void => {
      const content = editorSavedSoul(home, event)
      if (content !== null) {
        show(content)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onEditorSaved)
    window.addEventListener('focus', read)
    read()
    return () => {
      tickets.close()
      stopSaves()
      window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onEditorSaved)
      window.removeEventListener('focus', read)
    }
  }, [home, offline])
  return description
}
