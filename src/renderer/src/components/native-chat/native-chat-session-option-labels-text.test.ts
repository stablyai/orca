import { expect, it, vi } from 'vitest'
import { nativeChatSessionChoiceLabel } from '../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated } from './native-chat-session-option-labels-text'

vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) =>
    key.endsWith('.ultracode') ? 'Ultracode traduit' : fallback
}))

it('localizes the compound effort through the existing option label surface', () => {
  expect(
    nativeChatSessionChoiceLabel(
      { value: 'ultracode', label: 'ultracode' },
      sayNativeChatSessionOptionTranslated,
      'effort'
    )
  ).toBe('Ultracode traduit')
})
