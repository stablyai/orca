import { nativeChatCommandLanguage } from '../native-chat-command-language'
import { isNativeChatFileCountPath } from './native-chat-edit-patch-files'
import { nativeChatToolCategory } from './native-chat-tool-icon'
import {
  nativeChatFullCommand,
  nativeChatPlainCommandInput,
  nativeChatToolInputText
} from './native-chat-tool-input-text'
import { createToolInputDisplay, summarizeToolInput } from './native-chat-tool-summary'
import type { NativeChatToolCallBlock, NativeChatToolResultBlock } from '../../native-chat-types'

/** Shared desktop/mobile tool verbs; desktop translates the English record. */
export const NATIVE_CHAT_TOOL_ROW_VERB_COPY = {
  running: 'Running',
  ran: 'Ran',
  reading: 'Reading',
  read: 'Read',
  triedRead: 'Tried to read',
  editing: 'Editing',
  edited: 'Edited',
  triedEdit: 'Tried to edit',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  subagent: 'Subagent',
  searching: 'Searching',
  searched: 'Searched',
  triedSearch: 'Tried to search',
  listing: 'Listing',
  listed: 'Listed',
  triedList: 'Tried to list',
  fetching: 'Fetching',
  fetched: 'Fetched',
  triedFetch: 'Tried to fetch',
  searchingWeb: 'Searching the web',
  searchedWeb: 'Searched the web',
  triedSearchWeb: 'Tried to search the web'
} as const

export type NativeChatToolRowVerb = keyof typeof NATIVE_CHAT_TOOL_ROW_VERB_COPY

export type NativeChatToolLineLabel = {
  verb: NativeChatToolRowVerb | null
  target: string
  title: string
  command: boolean
  filePath: string | null
  /** The whole command, when the row had to shorten it. */
  commandDetail: string | null
  /** Grammar of `commandDetail`; null when the row holds no command text. */
  commandLanguage: string | null
}

function phaseVerb<T extends NativeChatToolRowVerb>(
  phase: { running: boolean; completed: boolean; failed: boolean },
  verbs: { running: T; completed: T; failed: T }
): T | null {
  if (phase.running) {
    return verbs.running
  }
  if (phase.completed) {
    return verbs.completed
  }
  return phase.failed ? verbs.failed : null
}

/** What a tool row says: the verb for its category and state, and the target it names. */
export function nativeChatToolLineLabel(
  call: NativeChatToolCallBlock,
  result?: NativeChatToolResultBlock
): NativeChatToolLineLabel {
  const display = createToolInputDisplay(call.input)
  const category = nativeChatToolCategory(call.name, call.mcpIdentity)
  const command = category === 'unknown'
  const running = call.state === 'running'
  const completed =
    call.state !== 'failed' &&
    !result?.isError &&
    (call.state === 'completed' || result !== undefined)
  const failed = call.state === 'failed' || result?.isError === true
  const phase = { running, completed, failed }
  let commandDetail: string | null = null
  let commandLanguage: string | null = null
  let verb: NativeChatToolRowVerb | null = null
  let target = display.label
  let title = display.filePath ?? target
  // Only reads/edits target files; Codex Diff’s N files summary names no openable path.
  const filePath =
    (category === 'read' || category === 'fileChange') &&
    display.filePath !== null &&
    !(call.name === 'Diff' && isNativeChatFileCountPath(display.filePath))
      ? display.filePath
      : null

  if (command) {
    const fullCommand = nativeChatFullCommand(call.input)
    target = fullCommand === null ? target : summarizeToolInput(fullCommand)
    title = fullCommand ?? target
    if (fullCommand !== null) {
      commandLanguage = nativeChatCommandLanguage(call.name, call.input)
      const plainCommand = nativeChatPlainCommandInput(call.input)
      if (plainCommand?.trim() === fullCommand) {
        commandDetail = plainCommand === target ? null : plainCommand
      }
    }
    if (running) {
      verb = 'running'
    } else if (completed || result !== undefined || call.exitCode !== undefined) {
      verb = 'ran'
    }
  } else if (category === 'read' || category === 'fileChange') {
    const read = category === 'read'
    if (running) {
      verb = read ? 'reading' : 'editing'
    } else if (failed) {
      verb = read ? 'triedRead' : 'triedEdit'
    } else if (completed) {
      verb = read ? 'read' : 'edited'
    }
    target = filePath?.split(/[\\/]/).findLast((part) => part.length > 0) ?? target
  } else if (category === 'subAgentActivity') {
    verb = 'subagent'
    target = nativeChatToolInputText(call.input, 'description') ?? target
    title = target
  } else if (category === 'search') {
    verb = phaseVerb(phase, { running: 'searching', completed: 'searched', failed: 'triedSearch' })
  } else if (category === 'listFiles') {
    verb = phaseVerb(phase, { running: 'listing', completed: 'listed', failed: 'triedList' })
  } else if (category === 'webSearch') {
    if (call.name.trim().toLowerCase() === 'webfetch') {
      const url = nativeChatToolInputText(call.input, 'url') ?? target
      target = url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
      title = url
      verb = phaseVerb(phase, { running: 'fetching', completed: 'fetched', failed: 'triedFetch' })
    } else {
      verb = phaseVerb(phase, {
        running: 'searchingWeb',
        completed: 'searchedWeb',
        failed: 'triedSearchWeb'
      })
    }
  }
  return { verb, target, title, command, filePath, commandDetail, commandLanguage }
}
