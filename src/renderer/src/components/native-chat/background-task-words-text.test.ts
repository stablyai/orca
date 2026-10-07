import { describe, expect, it, vi } from 'vitest'
import { translate } from '@/i18n/i18n'
import type * as I18nModule from '@/i18n/i18n'
import en from '@/i18n/locales/en.json'
import {
  BACKGROUND_TASK_COPY,
  sayBackgroundTaskEnglish,
  type BackgroundTaskCopyId
} from '../../../../shared/background-task-copy'
import { sayBackgroundTaskTranslated } from './background-task-words-text'

vi.mock('@/i18n/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof I18nModule>()
  return { ...actual, translate: vi.fn(actual.translate) }
})

const IDS = Object.keys(BACKGROUND_TASK_COPY).filter(
  (id): id is BackgroundTaskCopyId => id in BACKGROUND_TASK_COPY
)
const VALUES = { value0: '2 agents' }

describe('desktop words for the background-tasks strip', () => {
  it('says every piece as the phone does, in English', () => {
    for (const id of IDS) {
      expect([id, sayBackgroundTaskTranslated(id, VALUES)]).toEqual([
        id,
        sayBackgroundTaskEnglish(id, VALUES)
      ])
    }
  })

  // The catalog answers first in English, so read the default each key is given directly.
  it('keeps each existing key, with the shared piece as its English default', () => {
    for (const id of IDS) {
      vi.mocked(translate).mockClear()
      sayBackgroundTaskTranslated(id, VALUES)
      expect(vi.mocked(translate).mock.calls.map(([key, fallback]) => [key, fallback])).toEqual([
        [`components.native-chat.backgroundTasks.${id}`, BACKGROUND_TASK_COPY[id]]
      ])
    }
  })

  it('keeps the English catalog in step with the shared copy', () => {
    const catalog: Record<string, string> = en.components['native-chat'].backgroundTasks
    for (const id of IDS) {
      expect([id, catalog[id]]).toEqual([id, BACKGROUND_TASK_COPY[id]])
    }
  })
})
