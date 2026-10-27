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
  const value0 = { value0: count }
  if (live) {
    return liveClause(category, one, value0)
  }
  switch (category) {
    case 'read':
      return one
        ? translate('components.native-chat.tool.runReadOne', 'Read 1 file')
        : translate('components.native-chat.tool.runReadMany', 'Read {{value0}} files', value0)
    case 'search':
      return one
        ? translate('components.native-chat.tool.runSearchOne', 'Searched 1 time')
        : translate(
            'components.native-chat.tool.runSearchMany',
            'Searched {{value0}} times',
            value0
          )
    case 'listFiles':
      return one
        ? translate('components.native-chat.tool.runListFilesOne', 'Listed 1 directory')
        : translate(
            'components.native-chat.tool.runListFilesMany',
            'Listed {{value0}} directories',
            value0
          )
    case 'unknown':
      return one
        ? translate('components.native-chat.tool.runCommandOne', 'Ran 1 command')
        : translate('components.native-chat.tool.runCommandMany', 'Ran {{value0}} commands', value0)
    case 'fileChange':
      return one
        ? translate('components.native-chat.tool.runFileChangeOne', 'Edited 1 file')
        : translate(
            'components.native-chat.tool.runFileChangeMany',
            'Edited {{value0}} files',
            value0
          )
    case 'webSearch':
      return one
        ? translate('components.native-chat.tool.runWebSearchOne', 'Searched the web 1 time')
        : translate(
            'components.native-chat.tool.runWebSearchMany',
            'Searched the web {{value0}} times',
            value0
          )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runBrowserOne', 'Used the browser')
        : translate(
            'components.native-chat.tool.runBrowserMany',
            'Used the browser {{value0}} times',
            value0
          )
    case 'mcpToolCall':
      return one
        ? translate('components.native-chat.tool.runIntegrationOne', 'Used 1 integration')
        : translate(
            'components.native-chat.tool.runIntegrationMany',
            'Used {{value0}} integrations',
            value0
          )
    case 'subAgentActivity':
      return one
        ? translate('components.native-chat.tool.runAgentOne', 'Ran 1 agent')
        : translate('components.native-chat.tool.runAgentMany', 'Ran {{value0}} agents', value0)
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runPlanOne', 'Updated the plan')
        : translate(
            'components.native-chat.tool.runPlanMany',
            'Updated the plan {{value0}} times',
            value0
          )
    case 'other':
      return one
        ? translate('components.native-chat.tool.runToolOne', 'Used 1 tool')
        : translate('components.native-chat.tool.runToolMany', 'Used {{value0}} tools', value0)
  }
}

function liveClause(
  category: NativeChatToolCategory,
  one: boolean,
  value0: { value0: number }
): string {
  switch (category) {
    case 'read':
      return one
        ? translate('components.native-chat.tool.runLiveReadOne', 'Reading 1 file')
        : translate(
            'components.native-chat.tool.runLiveReadMany',
            'Reading {{value0}} files',
            value0
          )
    case 'search':
      return one
        ? translate('components.native-chat.tool.runLiveSearchOne', 'Searching 1 time')
        : translate(
            'components.native-chat.tool.runLiveSearchMany',
            'Searching {{value0}} times',
            value0
          )
    case 'listFiles':
      return one
        ? translate('components.native-chat.tool.runLiveListFilesOne', 'Listing 1 directory')
        : translate(
            'components.native-chat.tool.runLiveListFilesMany',
            'Listing {{value0}} directories',
            value0
          )
    case 'unknown':
      return one
        ? translate('components.native-chat.tool.runLiveCommandOne', 'Running 1 command')
        : translate(
            'components.native-chat.tool.runLiveCommandMany',
            'Running {{value0}} commands',
            value0
          )
    case 'fileChange':
      return one
        ? translate('components.native-chat.tool.runLiveFileChangeOne', 'Editing 1 file')
        : translate(
            'components.native-chat.tool.runLiveFileChangeMany',
            'Editing {{value0}} files',
            value0
          )
    case 'webSearch':
      return one
        ? translate('components.native-chat.tool.runLiveWebSearchOne', 'Searching the web 1 time')
        : translate(
            'components.native-chat.tool.runLiveWebSearchMany',
            'Searching the web {{value0}} times',
            value0
          )
    case 'browser':
      return one
        ? translate('components.native-chat.tool.runLiveBrowserOne', 'Using the browser')
        : translate(
            'components.native-chat.tool.runLiveBrowserMany',
            'Using the browser {{value0}} times',
            value0
          )
    case 'mcpToolCall':
      return one
        ? translate('components.native-chat.tool.runLiveIntegrationOne', 'Using 1 integration')
        : translate(
            'components.native-chat.tool.runLiveIntegrationMany',
            'Using {{value0}} integrations',
            value0
          )
    case 'subAgentActivity':
      return one
        ? translate('components.native-chat.tool.runLiveAgentOne', 'Running 1 agent')
        : translate(
            'components.native-chat.tool.runLiveAgentMany',
            'Running {{value0}} agents',
            value0
          )
    case 'todoList':
      return one
        ? translate('components.native-chat.tool.runLivePlanOne', 'Updating the plan')
        : translate(
            'components.native-chat.tool.runLivePlanMany',
            'Updating the plan {{value0}} times',
            value0
          )
    case 'other':
      return one
        ? translate('components.native-chat.tool.runLiveToolOne', 'Using 1 tool')
        : translate('components.native-chat.tool.runLiveToolMany', 'Using {{value0}} tools', value0)
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
