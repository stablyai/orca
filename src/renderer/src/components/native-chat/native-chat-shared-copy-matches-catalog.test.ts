import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en.json'
import { NATIVE_CHAT_TOOL_ACTIVITY_COPY } from '../../../../shared/native-chat-tool-activity'
import { NATIVE_CHAT_TURN_STATUS_COPY } from '../../../../shared/native-chat-turn-status'

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

  it('keeps the interpolation placeholders the catalog expects', () => {
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workedFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TURN_STATUS_COPY.workingFor).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.countN).toContain('{{value0}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningPreview).toContain('{{preview}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{toolName}}')
    expect(NATIVE_CHAT_TOOL_ACTIVITY_COPY.runningNamedPreview).toContain('{{preview}}')
  })
})
