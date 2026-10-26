import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat/tools/native-chat-tool-activity'
import {
  NATIVE_CHAT_COMPOSER_PLACEHOLDER,
  NATIVE_CHAT_TURN_STATUS_COPY
} from '../../../../shared/native-chat-turn-status'
import {
  NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY,
  NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY,
  NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS
} from '../../../../shared/native-chat/tools/native-chat-tool-run-sentence'
import { NATIVE_CHAT_TOOL_ROW_VERB_COPY } from '../../../../shared/native-chat/tools/native-chat-tool-line-label'
import { NATIVE_CHAT_DIFF_CARD_COPY } from '../../../../shared/native-chat/tools/native-chat-edit-cards'
import { NATIVE_CHAT_TASK_LIST_COPY } from '../../../../shared/native-chat-task-list'

// Shared mobile copy and desktop catalog fallbacks must match byte-for-byte to prevent silent platform drift.
const catalog = en as unknown as {
  components: {
    'native-chat': {
      status: Record<string, string>
      tool: Record<string, string>
    }
  }
}

const rowVerbCatalog: Record<string, string> = en.components['native-chat'].tool.row
const taskListCatalog: Record<string, string> = en.components['native-chat'].taskList

describe('native-chat shared copy matches the English catalog', () => {
  it.each(Object.entries(NATIVE_CHAT_TURN_STATUS_COPY))(
    'status.%s matches en.json',
    (key, value) => {
      expect(catalog.components['native-chat'].status[key]).toBe(value)
    }
  )

  it('composer.placeholder matches the shared composer placeholder', () => {
    expect(en.components['native-chat'].composer.placeholder).toBe(NATIVE_CHAT_COMPOSER_PLACEHOLDER)
  })

  it.each(Object.entries(NATIVE_CHAT_TOOL_ACTIVITY_COPY))(
    'tool.%s matches en.json',
    (key, value) => {
      expect(catalog.components['native-chat'].tool[key]).toBe(value)
    }
  )

  // Desktop extraction needs literal call-site sentences; mobile renders this record, so check parity.
  it.each([
    ['runReadOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.read.one],
    ['runReadMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.read.many],
    ['runSearchOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.search.one],
    ['runSearchMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.search.many],
    ['runListFilesOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.listFiles.one],
    ['runListFilesMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.listFiles.many],
    ['runCommandOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.unknown.one],
    ['runCommandMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.unknown.many],
    ['runFileChangeOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.fileChange.one],
    ['runFileChangeMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.fileChange.many],
    ['runWebSearchOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.webSearch.one],
    ['runWebSearchMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.webSearch.many],
    ['runBrowserOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.browser.one],
    ['runBrowserMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.browser.many],
    ['runIntegrationOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.mcpToolCall.one],
    ['runIntegrationMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.mcpToolCall.many],
    ['runAgentOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.subAgentActivity.one],
    ['runAgentMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.subAgentActivity.many],
    ['runPlanOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.todoList.one],
    ['runPlanMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.todoList.many],
    ['runToolOne', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.other.one],
    ['runToolMany', NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY.other.many],
    ['runPair', NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.pair],
    ['runList', NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list]
  ])('tool.%s matches the shared run sentence copy', (key, value) => {
    expect(catalog.components['native-chat'].tool[key]).toBe(value)
  })

  it.each([
    ['runLiveReadOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.read.one],
    ['runLiveReadMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.read.many],
    ['runLiveSearchOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.search.one],
    ['runLiveSearchMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.search.many],
    ['runLiveListFilesOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.listFiles.one],
    ['runLiveListFilesMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.listFiles.many],
    ['runLiveCommandOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.unknown.one],
    ['runLiveCommandMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.unknown.many],
    ['runLiveFileChangeOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.fileChange.one],
    ['runLiveFileChangeMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.fileChange.many],
    ['runLiveWebSearchOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.webSearch.one],
    ['runLiveWebSearchMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.webSearch.many],
    ['runLiveBrowserOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.browser.one],
    ['runLiveBrowserMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.browser.many],
    ['runLiveIntegrationOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.mcpToolCall.one],
    ['runLiveIntegrationMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.mcpToolCall.many],
    ['runLiveAgentOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.subAgentActivity.one],
    ['runLiveAgentMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.subAgentActivity.many],
    ['runLivePlanOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.todoList.one],
    ['runLivePlanMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.todoList.many],
    ['runLiveToolOne', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.other.one],
    ['runLiveToolMany', NATIVE_CHAT_TOOL_RUN_LIVE_SENTENCE_COPY.other.many]
  ])('tool.%s matches the shared live run sentence copy', (key, value) => {
    expect(catalog.components['native-chat'].tool[key]).toBe(value)
  })

  it.each(Object.entries(NATIVE_CHAT_TOOL_ROW_VERB_COPY))(
    'tool.row.%s matches the shared row verb copy',
    (key, value) => {
      expect(rowVerbCatalog[key]).toBe(value)
    }
  )

  it.each(Object.entries(NATIVE_CHAT_DIFF_CARD_COPY))(
    'tool.%s matches the shared diff card copy',
    (key, value) => {
      expect(catalog.components['native-chat'].tool[key]).toBe(value)
    }
  )

  it.each(Object.entries(NATIVE_CHAT_TASK_LIST_COPY))(
    'taskList.%s matches the shared task list copy',
    (key, value) => {
      expect(taskListCatalog[key]).toBe(value)
    }
  )

  it('keeps the interpolation placeholders the catalog expects', () => {
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workedFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workingFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningPreview).toContain('{{preview}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{toolName}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{preview}}')
  })
})
