import { describe, expect, it } from 'vitest'
import {
  classifyNativeChatGraduationCohort,
  isNativeChatGraduationCohort,
  isNativeChatGraduationOptIn
} from './native-chat-graduation-cohort'

describe('native chat graduation cohort', () => {
  it('admits only a saved profile that had experimental native chat explicitly on', () => {
    expect(
      classifyNativeChatGraduationCohort({
        fileExistedOnLoad: true,
        savedExperimentalNativeChat: true
      })
    ).toBe('experimental-opt-in')
    for (const savedExperimentalNativeChat of [false, undefined, null, 'true', 1]) {
      expect(
        classifyNativeChatGraduationCohort({ fileExistedOnLoad: true, savedExperimentalNativeChat })
      ).toBe('other')
    }
    expect(
      classifyNativeChatGraduationCohort({
        fileExistedOnLoad: false,
        savedExperimentalNativeChat: true
      })
    ).toBe('other')
  })

  it('fails closed on a missing or malformed marker', () => {
    expect(isNativeChatGraduationOptIn({ nativeChatGraduationCohort: 'experimental-opt-in' })).toBe(
      true
    )
    for (const nativeChatGraduationCohort of [undefined, null, 'other', 'opt-in', true, {}]) {
      expect(isNativeChatGraduationOptIn({ nativeChatGraduationCohort })).toBe(false)
    }
    expect(isNativeChatGraduationOptIn(null)).toBe(false)
    expect(isNativeChatGraduationCohort('opt-in')).toBe(false)
  })
})
