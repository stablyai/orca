import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat-tool-activity'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../../shared/native-chat-turn-status'
import {
  NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY,
  NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS
} from '../../../../shared/native-chat-tool-run-sentence'

// The shared copy is desktop's i18n fallback and mobile's actual rendered string.
// If the two drift, desktop keeps showing en.json while mobile shows the constant —
// silently, since neither side errors. These are the exact keys that made these
// strings runtime-required (i18next can no longer rebuild them from a literal
// call-site default), so they must stay byte-identical to the catalog.
const catalog = en as unknown as {
  components: {
    'native-chat': {
      status: Record<string, string>
      tool: Record<string, string>
    }
  }
}

describe('native-chat shared copy matches the English catalog', () => {
  it.each(Object.entries(NATIVE_CHAT_TURN_STATUS_COPY))(
    'status.%s matches en.json',
    (key, value) => {
      expect(catalog.components['native-chat'].status[key]).toBe(value)
    }
  )

  it.each(Object.entries(NATIVE_CHAT_TOOL_ACTIVITY_COPY))(
    'tool.%s matches en.json',
    (key, value) => {
      expect(catalog.components['native-chat'].tool[key]).toBe(value)
    }
  )

  // The run sentence is spelled out as literals at its call sites so the
  // extractor can see them, and mobile renders the record instead. These are the
  // pairs that would drift silently.
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

  it('keeps the interpolation placeholders the catalog expects', () => {
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workedFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workingFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningPreview).toContain('{{preview}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{toolName}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{preview}}')
  })
})
