// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { resolveNativeChatAppearanceSettings } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import { AppearanceChatTextWeightControl } from './AppearanceChatTextWeightControl'

vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, text: string) => text
}))
vi.mock('../../section-layout/SearchableSetting', () => ({
  SearchableSetting: ({ children }: React.PropsWithChildren) => children
}))
vi.mock('../../form-controls/SettingsDisabledControlTooltip', () => ({
  SettingsDisabledControlTooltip: ({ children }: React.PropsWithChildren) => children
}))
vi.mock('../../../ui/slider', () => ({
  Slider: ({
    value,
    onValueChange,
    onValueCommit
  }: {
    value: number[]
    onValueChange: (value: number[]) => void
    onValueCommit: (value: number[]) => void
  }) => (
    <input
      type="range"
      min="300"
      max="500"
      step="100"
      value={value[0]}
      onChange={() => {
        onValueChange([500])
        onValueCommit([500])
      }}
    />
  )
}))

it('restores the saved weight after a failed save and allows the same choice to be retried', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root = createRoot(container)
  const onChange = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  try {
    await act(async () =>
      root.render(
        <AppearanceChatTextWeightControl
          appearance={resolveNativeChatAppearanceSettings({ fontWeight: 400 })}
          onChange={onChange}
        />
      )
    )
    const input = container.querySelector('input')!
    const change = async () =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '500'
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await change()
    expect(input.value).toBe('400')
    await change()
    expect(onChange.mock.calls).toEqual([[{ fontWeight: 500 }], [{ fontWeight: 500 }]])
    expect(input.value).toBe('500')
  } finally {
    act(() => root.unmount())
  }
})
