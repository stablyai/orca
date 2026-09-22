import { translate } from '@/i18n/i18n'
import {
  joinNativeChatToolRunClauses,
  nativeChatToolRunClauses
} from '../../../../shared/native-chat-tool-run-sentence'
import type { NativeChatToolCategory } from '../../../../shared/native-chat-tool-icon'
import { isToolCallBlock, type NativeChatBlock } from '../../../../shared/native-chat-types'
import { toolInputCommand } from '../../../../shared/native-chat-tool-summary'

/** One clause, localized.
 *
 *  Spelled out per category, with the English literal at the call site: the
 *  catalog extractor reads only string literals, so a key built at runtime — or
 *  a fallback read from the shared record — never reaches a translator, and the
 *  sentence would stay English in every locale while the row above it translated.
 *  `native-chat-shared-copy-matches-catalog` pins these against the record mobile
 *  renders from, which is what keeps the duplication honest. */
function clause(category: NativeChatToolCategory, count: number): string {
  const one = count === 1
  const value0 = { value0: count }
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

/** The one line a settled run reads as, localized. */
export function nativeChatToolRunSentence(blocks: readonly NativeChatBlock[]): string | null {
  const calls = blocks.filter(isToolCallBlock)
  if (calls.length === 0) {
    return null
  }
  // A lone shell call keeps its own command: `git push` identifies the work
  // better than "Ran 1 command" can, and it is the row the reader would open
  // anyway. A call carrying no command has nothing better than its category.
  if (calls.length === 1) {
    const command = toolInputCommand(calls[0].input)
    if (command !== null && command.length > 0) {
      return command
    }
  }
  return joinNativeChatToolRunClauses(
    nativeChatToolRunClauses(calls).map(({ category, count }) => clause(category, count)),
    {
      pair: (first, second) =>
        translate('components.native-chat.tool.runPair', '{{value0}} and {{value1}}', {
          value0: first,
          value1: second
        }),
      list: (leading, last) =>
        translate('components.native-chat.tool.runList', '{{value0}}, and {{value1}}', {
          value0: leading,
          value1: last
        })
    }
  )
}
