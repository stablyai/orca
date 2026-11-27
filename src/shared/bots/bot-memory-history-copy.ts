// How Settings › Memory › History words one change, on the desktop and the phone.
import { type BotMemoryLine, parseBotMemoryFacts } from '../bot-memory-lines'
import type { BotChatTranslate } from './bot-chat-tree'
import type { BotMemoryHistoryView } from './bot-memory-history'

/** The row's mark: what kind of change it was. */
export type BotMemoryHistoryKind = 'tidy-up' | 'undo' | 'edit' | 'forget' | 'add'

/** The line without its bullet, for the opened change. */
export function botMemoryHistoryLine({ line }: BotMemoryLine): string {
  return line.replace(/^\s*[-*]\s+/, '').trim()
}

function factText({ line }: BotMemoryLine): string {
  return parseBotMemoryFacts(line)[0]?.text ?? line.trim()
}

export function botMemoryHistoryKind({ by, change }: BotMemoryHistoryView): BotMemoryHistoryKind {
  if (by.kind === 'tidy-up') {
    return 'tidy-up'
  }
  if (by.kind === 'undo' || by.kind === 'kept') {
    return 'undo'
  }
  if (change.added.length > 0 && change.removed.length > 0) {
    return 'edit'
  }
  return change.removed.length > 0 ? 'forget' : 'add'
}

/** What changed, in a few words. */
export function botMemoryHistorySummary(
  t: BotChatTranslate,
  { by, change }: BotMemoryHistoryView
): string {
  const { added, removed } = change
  // One row for the whole night, so it says so rather than naming one change.
  if (by.kind === 'tidy-up') {
    return t('settings.bots.memoryHistory.tidied', 'Tidied {{count}} lines', {
      count: added.length + removed.length
    })
  }
  if (by.kind === 'kept') {
    return added.length === 1
      ? t('settings.bots.memoryHistory.keptOne', 'Kept a line another chat wrote over')
      : t('settings.bots.memoryHistory.keptMany', 'Kept {{count}} lines other chats wrote over', {
          count: added.length
        })
  }
  if (added.length === 1 && removed.length <= 1) {
    const fact = factText(added[0])
    return removed.length === 0
      ? t('settings.bots.memoryHistory.added', 'Added: {{fact}}', { fact })
      : t('settings.bots.memoryHistory.edited', 'Edited: {{fact}}', { fact })
  }
  if (added.length === 0 && removed.length === 1) {
    return t('settings.bots.memoryHistory.forgot', 'Forgot: {{fact}}', {
      fact: factText(removed[0])
    })
  }
  if (removed.length === 0) {
    return t('settings.bots.memoryHistory.addedMany', 'Added {{count}} lines', {
      count: added.length
    })
  }
  return added.length === 0
    ? t('settings.bots.memoryHistory.forgotMany', 'Forgot {{count}} lines', {
        count: removed.length
      })
    : t('settings.bots.memoryHistory.changedMany', 'Changed {{count}} lines', {
        count: added.length + removed.length
      })
}

/** Who made it, and whether it can be undone. */
export function botMemoryHistoryAuthor(t: BotChatTranslate, row: BotMemoryHistoryView): string {
  const author = authorOf(t, row)
  return row.undoable
    ? author
    : t('settings.bots.memoryHistory.secret', '{{author}} · Can’t be undone: it held a secret', {
        author
      })
}

function authorOf(t: BotChatTranslate, { by, chat }: BotMemoryHistoryView): string {
  const named = chat
    ? t('settings.bots.memoryHistory.chat', 'Chat “{{title}}”', { title: chat })
    : t('settings.bots.memoryHistory.aChat', 'A chat')
  switch (by.kind) {
    case 'chat':
      return by.source
        ? t('settings.bots.memoryHistory.chatFrom', '{{chat}} · from {{source}}', {
            chat: named,
            source: by.source
          })
        : named
    case 'kept':
      return t('settings.bots.memoryHistory.kept', 'Orca · {{chat}} wrote over it', {
        chat: named
      })
    case 'owner':
      return t('settings.bots.memoryHistory.owner', 'You, in Settings')
    case 'bot':
      return t('settings.bots.memoryHistory.bot', 'Forget, from {{chat}}', { chat: named })
    case 'undo':
      return t('settings.bots.memoryHistory.undo', 'Undo')
    case 'tidy-up':
      return t(
        'settings.bots.memoryHistory.tidyUp',
        'Tidy-up · Undo puts back all of its MEMORY.md changes'
      )
  }
}
