import { translate } from '@/i18n/i18n'
import {
  nativeChatToolRunSentence as sharedRunSentence,
  type NativeChatToolRunSentenceWords
} from '../../../../shared/native-chat/tools/native-chat-tool-run-sentence'
import type { NativeChatToolCategory } from '../../../../shared/native-chat/tools/native-chat-tool-icon'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

/** Extraction requires literal keys/fallbacks; parity tests keep these clauses aligned with mobile’s shared record. */
function clause(category: NativeChatToolCategory, count: number, live: boolean): string {
  const one = count === 1
  const plural = { count }
  if (live) {
    return liveClause(category, one, plural)
  }
  switch (category) {
    case 'read':
      return one
        ? translate('components.native-chat.tool.runRead_one', 'Read {{count}} file', plural)
        : translate('components.native-chat.tool.runRead_other', 'Read {{count}} files', plural)
    case 'search':
      return one
        ? translate('components.native-chat.tool.runSearch_one', 'Searched {{count}} time', plural)
        : translate(
            'components.native-chat.tool.runSearch_other',
            'Searched {{count}} times',
            plural
          )
    case 'listFiles':
      return one
        ? translate(
            'components.native-chat.tool.runListFiles_one',
            'Listed {{count}} directory',
            plural
          )
        : translate(
            'components.native-chat.tool.runListFiles_other',
            'Listed {{count}} directories',
            plural
          )
    case 'unknown':
      return one
        ? translate('components.native-chat.tool.runCommand_one', 'Ran {{count}} command', plural)
        : translate(
            'components.native-chat.tool.runCommand_other',
            'Ran {{count}} commands',
            plural
          )
    case 'fileChange':
      return one
        ? translate(
            'components.native-chat.tool.runFileChange_one',
            'Edited {{count}} file',
            plural
          )
        : translate(
            'components.native-chat.tool.runFileChange_other',
            'Edited {{count}} files',
            plural
          )
    case 'webSearch':
      return one
        ? translate(
            'components.native-chat.tool.runWebSearch_one',
            'Searched the web {{count}} time',
            plural
          )
        : translate(
            'components.native-chat.tool.runWebSearch_other',
            'Searched the web {{count}} times',
            plural
          )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runBrowserOne', 'Used the browser')
        : translate(
            'components.native-chat.tool.runBrowser_other',
            'Used the browser {{count}} times',
            plural
          )
    case 'mcpToolCall':
      return one
        ? translate(
            'components.native-chat.tool.runIntegration_one',
            'Used {{count}} integration',
            plural
          )
        : translate(
            'components.native-chat.tool.runIntegration_other',
            'Used {{count}} integrations',
            plural
          )
    case 'subAgentActivity':
      return one
        ? translate('components.native-chat.tool.runAgent_one', 'Ran {{count}} agent', plural)
        : translate('components.native-chat.tool.runAgent_other', 'Ran {{count}} agents', plural)
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runPlanOne', 'Updated the plan')
        : translate(
            'components.native-chat.tool.runPlan_other',
            'Updated the plan {{count}} times',
            plural
          )
    case 'other':
      return one
        ? translate('components.native-chat.tool.runTool_one', 'Used {{count}} tool', plural)
        : translate('components.native-chat.tool.runTool_other', 'Used {{count}} tools', plural)
  }
}

function liveClause(
  category: NativeChatToolCategory,
  one: boolean,
  plural: { count: number }
): string {
  switch (category) {
    case 'read':
      return one
        ? translate('components.native-chat.tool.runLiveRead_one', 'Reading {{count}} file', plural)
        : translate(
            'components.native-chat.tool.runLiveRead_other',
            'Reading {{count}} files',
            plural
          )
    case 'search':
      return one
        ? translate(
            'components.native-chat.tool.runLiveSearch_one',
            'Searching {{count}} time',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveSearch_other',
            'Searching {{count}} times',
            plural
          )
    case 'listFiles':
      return one
        ? translate(
            'components.native-chat.tool.runLiveListFiles_one',
            'Listing {{count}} directory',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveListFiles_other',
            'Listing {{count}} directories',
            plural
          )
    case 'unknown':
      return one
        ? translate(
            'components.native-chat.tool.runLiveCommand_one',
            'Running {{count}} command',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveCommand_other',
            'Running {{count}} commands',
            plural
          )
    case 'fileChange':
      return one
        ? translate(
            'components.native-chat.tool.runLiveFileChange_one',
            'Editing {{count}} file',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveFileChange_other',
            'Editing {{count}} files',
            plural
          )
    case 'webSearch':
      return one
        ? translate(
            'components.native-chat.tool.runLiveWebSearch_one',
            'Searching the web {{count}} time',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveWebSearch_other',
            'Searching the web {{count}} times',
            plural
          )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runLiveBrowserOne', 'Using the browser')
        : translate(
            'components.native-chat.tool.runLiveBrowser_other',
            'Using the browser {{count}} times',
            plural
          )
    case 'mcpToolCall':
      return one
        ? translate(
            'components.native-chat.tool.runLiveIntegration_one',
            'Using {{count}} integration',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveIntegration_other',
            'Using {{count}} integrations',
            plural
          )
    case 'subAgentActivity':
      return one
        ? translate(
            'components.native-chat.tool.runLiveAgent_one',
            'Running {{count}} agent',
            plural
          )
        : translate(
            'components.native-chat.tool.runLiveAgent_other',
            'Running {{count}} agents',
            plural
          )
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runLivePlanOne', 'Updating the plan')
        : translate(
            'components.native-chat.tool.runLivePlan_other',
            'Updating the plan {{count}} times',
            plural
          )
    case 'other':
      return one
        ? translate('components.native-chat.tool.runLiveTool_one', 'Using {{count}} tool', plural)
        : translate(
            'components.native-chat.tool.runLiveTool_other',
            'Using {{count}} tools',
            plural
          )
  }
}

const LOCALIZED_WORDS: NativeChatToolRunSentenceWords = {
  clause,
  pair: (first, second) =>
    translate('components.native-chat.tool.runPair', '{{value0}} and {{value1}}', {
      value0: first,
      value1: second
    }),
  list: (leading, last) =>
    translate('components.native-chat.tool.runList', '{{value0}}, and {{value1}}', {
      value0: leading.join(translate('components.native-chat.tool.runListSeparator', ', ')),
      value1: last
    })
}

export function nativeChatToolRunSentence(
  blocks: readonly NativeChatBlock[],
  { live = false }: { live?: boolean } = {}
): string | null {
  return sharedRunSentence(blocks, { live }, LOCALIZED_WORDS)
}
