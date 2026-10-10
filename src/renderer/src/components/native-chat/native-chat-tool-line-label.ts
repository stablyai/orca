import { translate } from '@/i18n/i18n'
import { nativeChatCommandLanguage } from './native-chat-command-language'
import { nativeChatToolCategory } from './native-chat-tool-category'
import {
  nativeChatFullCommand,
  nativeChatPlainCommandInput,
  nativeChatToolInputText
} from './native-chat-tool-input-text'
import {
  createToolInputDisplay,
  summarizeToolInput
} from '../../../../shared/native-chat-tool-summary'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'

export function nativeChatToolLineLabel(
  call: NativeChatToolCallBlock,
  result?: NativeChatToolResultBlock
): {
  verb: string | null
  target: string
  title: string
  command: boolean
  filePath: string | null
  /** The whole command, when the row had to shorten it. */
  commandDetail: string | null
  /** Grammar of `commandDetail`; null when the row holds no command text. */
  commandLanguage: string | null
} {
  const display = createToolInputDisplay(call.input)
  const category = nativeChatToolCategory(call.name, call.mcpIdentity)
  const command = category === 'unknown'
  const running = call.state === 'running'
  const completed =
    call.state !== 'failed' &&
    !result?.isError &&
    (call.state === 'completed' || result !== undefined)
  const failed = call.state === 'failed' || result?.isError === true
  let commandDetail: string | null = null
  let commandLanguage: string | null = null
  let verb: string | null = null
  let target = display.label
  let title = display.filePath ?? target
  const filePath = category === 'read' || category === 'fileChange' ? display.filePath : null

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
      verb = translate('components.native-chat.tool.row.running', 'Running')
    } else if (completed || result !== undefined || call.exitCode !== undefined) {
      verb = translate('components.native-chat.tool.row.ran', 'Ran')
    }
  } else if (category === 'read' || category === 'fileChange') {
    if (running) {
      verb =
        category === 'read'
          ? translate('components.native-chat.tool.row.reading', 'Reading')
          : translate('components.native-chat.tool.row.editing', 'Editing')
    } else if (completed) {
      verb =
        category === 'read'
          ? translate('components.native-chat.tool.row.read', 'Read')
          : translate('components.native-chat.tool.row.edited', 'Edited')
    }
    if (!running && failed) {
      verb =
        category === 'read'
          ? translate('components.native-chat.tool.row.triedRead', 'Tried to read')
          : translate('components.native-chat.tool.row.triedEdit', 'Tried to edit')
    }
    target = filePath?.split(/[\\/]/).findLast((part) => part.length > 0) ?? target
  } else if (category === 'subAgentActivity') {
    verb = translate('components.native-chat.tool.row.subagent', 'Subagent')
    target = nativeChatToolInputText(call.input, 'description') ?? target
    title = target
  } else if (category === 'search') {
    if (running) {
      verb = translate('components.native-chat.tool.row.searching', 'Searching')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.searched', 'Searched')
    } else if (failed) {
      verb = translate('components.native-chat.tool.row.triedSearch', 'Tried to search')
    }
  } else if (category === 'listFiles') {
    if (running) {
      verb = translate('components.native-chat.tool.row.listing', 'Listing')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.listed', 'Listed')
    } else if (failed) {
      verb = translate('components.native-chat.tool.row.triedList', 'Tried to list')
    }
  } else if (category === 'webSearch') {
    if (call.name.trim().toLowerCase() === 'webfetch') {
      const url = nativeChatToolInputText(call.input, 'url') ?? target
      target = url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
      title = url
      if (running) {
        verb = translate('components.native-chat.tool.row.fetching', 'Fetching')
      } else if (completed) {
        verb = translate('components.native-chat.tool.row.fetched', 'Fetched')
      } else if (failed) {
        verb = translate('components.native-chat.tool.row.triedFetch', 'Tried to fetch')
      }
    } else if (running) {
      verb = translate('components.native-chat.tool.row.searchingWeb', 'Searching the web')
    } else if (completed) {
      verb = translate('components.native-chat.tool.row.searchedWeb', 'Searched the web')
    } else if (failed) {
      verb = translate('components.native-chat.tool.row.triedSearchWeb', 'Tried to search the web')
    }
  }
  return { verb, target, title, command, filePath, commandDetail, commandLanguage }
}
