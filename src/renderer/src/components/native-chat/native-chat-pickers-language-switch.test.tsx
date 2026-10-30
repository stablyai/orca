// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatPermissionModePicker } from './NativeChatPermissionModePicker'
import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

const MODES = ['ask', 'auto'] as const
const onSelect = vi.fn()
const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn(),
  invokeAction: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}
const snapshot: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: { type: 'select', currentValue: 'opus', choices: [{ value: 'opus', label: 'Opus' }] },
    valueSource: 'applied',
    transport: 'catalog',
    settable: true
  }
]

it('relabels memoized composer pickers when only the UI language changes', async () => {
  render(
    <TooltipProvider>
      <NativeChatPermissionModePicker
        agent="claude"
        current="ask"
        modes={MODES}
        onSelect={onSelect}
      />
      <NativeChatSessionOptionPickers surface={surface} snapshot={snapshot} isWorking={false} />
    </TooltipProvider>
  )
  expect(screen.getByText('Ask for approval')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Model Opus/ })).toBeTruthy()

  await act(() => i18n.changeLanguage('fr'))

  expect(screen.getByText('Demander l’approbation')).toBeTruthy()
  expect(screen.getByRole('button', { name: /^Modèle Opus/ })).toBeTruthy()
})
