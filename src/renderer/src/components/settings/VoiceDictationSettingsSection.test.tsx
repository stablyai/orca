// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { i18n } from '@/i18n/i18n'
import { VoiceDictationSettingsSection } from './VoiceDictationSettingsSection'

const { shortcutLabel } = vi.hoisted(() => ({ shortcutLabel: vi.fn() }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: shortcutLabel }))
vi.mock('./VoiceMicrophoneSetting', () => ({ VoiceMicrophoneSetting: () => null }))

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('dictation shortcut explanations', () => {
  it.each([
    ['en', '⌘E'],
    ['en', 'Ctrl+E'],
    ['ko', '⌘E'],
    ['ko', 'Ctrl+E']
  ])('renders complete %s sentences with the platform shortcut %s', async (language, shortcut) => {
    await i18n.changeLanguage(language)
    shortcutLabel.mockReturnValue(shortcut)
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <VoiceDictationSettingsSection
          voiceSettings={getDefaultVoiceSettings()}
          permissionPending={false}
          onToggleVoiceDictation={vi.fn()}
          onUpdateVoiceSettings={vi.fn()}
        />
      )
    })
    try {
      const descriptions = Array.from(container.querySelectorAll('p'), (p) => p.textContent)
      if (language === 'ko') {
        expect(descriptions).toEqual([
          `${shortcut} 단축키를 눌러 포커스된 패널에 텍스트를 받아쓰세요.`,
          `토글: ${shortcut} 단축키를 한 번 누르면 받아쓰기를 시작하고, 다시 누르면 중지합니다. 길게 누르기: ${shortcut} 단축키를 누르고 있는 동안 받아쓰기합니다.`
        ])
      } else {
        expect(descriptions).toEqual([
          `Press ${shortcut} to dictate text into any focused pane.`,
          `Toggle: press ${shortcut} once to start, again to stop. Hold: dictate while ${shortcut} is held.`
        ])
      }
    } finally {
      await act(async () => root.unmount())
    }
  })
})
