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
  if (live) {
    return liveClause(category, count)
  }
  switch (category) {
    case 'read':
      return translate('components.native-chat.tool.runRead', 'Read {{count}} files', {
        count,
        defaultValue_one: 'Read {{count}} file'
      })
    case 'search':
      return translate('components.native-chat.tool.runSearch', 'Searched {{count}} times', {
        count,
        defaultValue_one: 'Searched {{count}} time'
      })
    case 'listFiles':
      return translate('components.native-chat.tool.runListFiles', 'Listed {{count}} directories', {
        count,
        defaultValue_one: 'Listed {{count}} directory'
      })
    case 'unknown':
      return translate('components.native-chat.tool.runCommand', 'Ran {{count}} commands', {
        count,
        defaultValue_one: 'Ran {{count}} command'
      })
    case 'fileChange':
      return translate('components.native-chat.tool.runFileChange', 'Edited {{count}} files', {
        count,
        defaultValue_one: 'Edited {{count}} file'
      })
    case 'webSearch':
      return translate(
        'components.native-chat.tool.runWebSearch',
        'Searched the web {{count}} times',
        { count, defaultValue_one: 'Searched the web {{count}} time' }
      )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runBrowserOne', 'Used the browser')
        : translate('components.native-chat.tool.runBrowser', 'Used the browser {{count}} times', {
            count,
            defaultValue_one: 'Used the browser {{count}} time'
          })
    case 'mcpToolCall':
      return translate(
        'components.native-chat.tool.runIntegration',
        'Used {{count}} integrations',
        { count, defaultValue_one: 'Used {{count}} integration' }
      )
    case 'subAgentActivity':
      return translate('components.native-chat.tool.runAgent', 'Ran {{count}} agents', {
        count,
        defaultValue_one: 'Ran {{count}} agent'
      })
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runPlanOne', 'Updated the plan')
        : translate('components.native-chat.tool.runPlan', 'Updated the plan {{count}} times', {
            count,
            defaultValue_one: 'Updated the plan {{count}} time'
          })
    case 'other':
      return translate('components.native-chat.tool.runTool', 'Used {{count}} tools', {
        count,
        defaultValue_one: 'Used {{count}} tool'
      })
  }
}

function liveClause(category: NativeChatToolCategory, count: number): string {
  const one = count === 1
  switch (category) {
    case 'read':
      return translate('components.native-chat.tool.runLiveRead', 'Reading {{count}} files', {
        count,
        defaultValue_one: 'Reading {{count}} file'
      })
    case 'search':
      return translate('components.native-chat.tool.runLiveSearch', 'Searching {{count}} times', {
        count,
        defaultValue_one: 'Searching {{count}} time'
      })
    case 'listFiles':
      return translate(
        'components.native-chat.tool.runLiveListFiles',
        'Listing {{count}} directories',
        { count, defaultValue_one: 'Listing {{count}} directory' }
      )
    case 'unknown':
      return translate('components.native-chat.tool.runLiveCommand', 'Running {{count}} commands', {
        count,
        defaultValue_one: 'Running {{count}} command'
      })
    case 'fileChange':
      return translate('components.native-chat.tool.runLiveFileChange', 'Editing {{count}} files', {
        count,
        defaultValue_one: 'Editing {{count}} file'
      })
    case 'webSearch':
      return translate(
        'components.native-chat.tool.runLiveWebSearch',
        'Searching the web {{count}} times',
        { count, defaultValue_one: 'Searching the web {{count}} time' }
      )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runLiveBrowserOne', 'Using the browser')
        : translate(
            'components.native-chat.tool.runLiveBrowser',
            'Using the browser {{count}} times',
            { count, defaultValue_one: 'Using the browser {{count}} time' }
          )
    case 'mcpToolCall':
      return translate(
        'components.native-chat.tool.runLiveIntegration',
        'Using {{count}} integrations',
        { count, defaultValue_one: 'Using {{count}} integration' }
      )
    case 'subAgentActivity':
      return translate('components.native-chat.tool.runLiveAgent', 'Running {{count}} agents', {
        count,
        defaultValue_one: 'Running {{count}} agent'
      })
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runLivePlanOne', 'Updating the plan')
        : translate(
            'components.native-chat.tool.runLivePlan',
            'Updating the plan {{count}} times',
            { count, defaultValue_one: 'Updating the plan {{count}} time' }
          )
    case 'other':
      return translate('components.native-chat.tool.runLiveTool', 'Using {{count}} tools', {
        count,
        defaultValue_one: 'Using {{count}} tool'
      })
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
