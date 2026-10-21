import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import type * as I18nModule from '@/i18n/i18n'
import en from '@/i18n/locales/en.json'
import {
  NATIVE_CHAT_SUBAGENT_GROUP_COPY,
  sayNativeChatSubagentGroupEnglish,
  type NativeChatSubagentGroupCopyId
} from '../../../../shared/native-chat-subagent-group-header'
import { sayNativeChatSubagentGroupTranslated } from './native-chat-subagent-group-words-text'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return { ...actual, translate: vi.fn(actual.translate) }
})

const IDS = Object.keys(NATIVE_CHAT_SUBAGENT_GROUP_COPY).filter(
  (id): id is NativeChatSubagentGroupCopyId => id in NATIVE_CHAT_SUBAGENT_GROUP_COPY
)
const VALUES = { value0: 3 }

function isCatalogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function catalogEntry(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((node, part) => (isCatalogObject(node) ? node[part] : undefined), en)
}

describe('desktop words for a transcript roster row', () => {
  it('says every piece as the phone does, in English', () => {
    for (const id of IDS) {
      expect([id, sayNativeChatSubagentGroupTranslated(id, VALUES)]).toEqual([
        id,
        sayNativeChatSubagentGroupEnglish(id, VALUES)
      ])
    }
  })

  it('gives each key the shared piece as its English default, and the catalog agrees', () => {
    for (const id of IDS) {
      vi.mocked(translate).mockClear()
      sayNativeChatSubagentGroupTranslated(id, VALUES)
      const calls = vi.mocked(translate).mock.calls
      expect(calls).toHaveLength(1)
      const [key, fallback] = calls[0]!
      expect([id, fallback]).toEqual([id, NATIVE_CHAT_SUBAGENT_GROUP_COPY[id]])
      expect(key.startsWith('components.native-chat.subagents.')).toBe(true)
      expect([key, catalogEntry(key)]).toEqual([key, NATIVE_CHAT_SUBAGENT_GROUP_COPY[id]])
    }
  })
})
