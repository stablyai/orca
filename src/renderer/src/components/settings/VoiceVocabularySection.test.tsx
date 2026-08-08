// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { parseCustomVocabularyDraft, VoiceVocabularySection } from './VoiceVocabularySection'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('parseCustomVocabularyDraft', () => {
  it('normalizes comma and newline separated mixed-language terms', () => {
    expect(parseCustomVocabularyDraft('  Orca\n\norca, Qwen3-ASR，中文术语  ')).toEqual([
      'Orca',
      'Qwen3-ASR',
      '中文术语'
    ])
  })
})

describe('VoiceVocabularySection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('persists normalized vocabulary when the textarea loses focus', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onUpdateVoiceSettings = vi.fn()

    act(() => {
      root.render(
        <VoiceVocabularySection
          voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true }}
          onUpdateVoiceSettings={onUpdateVoiceSettings}
        />
      )
    })

    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      )?.set
      valueSetter?.call(textarea, ' Orca\nQwen3-ASR\nORCA ')
      textarea?.dispatchEvent(new Event('input', { bubbles: true }))
      textarea?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(onUpdateVoiceSettings).toHaveBeenCalledWith({
      customVocabulary: ['Orca', 'Qwen3-ASR']
    })
    act(() => root.unmount())
  })
})
