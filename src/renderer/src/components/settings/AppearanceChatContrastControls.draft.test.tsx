// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Slider } from '../ui/slider'
import { resolveNativeChatAppearanceSettings } from '../../../../shared/native-chat-appearance-settings'
import { AppearanceChatContrastControls } from './AppearanceChatContrastControls'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))
vi.mock('../ui/slider', () => ({
  Slider: ({ value, onValueChange, onValueCommit }: ComponentProps<typeof Slider>) => (
    <input
      aria-label="Contrast"
      type="range"
      min={50}
      max={150}
      value={value?.[0]}
      onChange={(event) => onValueChange?.([Number(event.target.value)])}
      onPointerUp={(event) => onValueCommit?.([Number(event.currentTarget.value)])}
    />
  )
}))
afterEach(cleanup)

describe('contrast drag persistence', () => {
  it('updates the displayed draft during dragging and saves once on commit', () => {
    const onChange = vi.fn()
    render(
      <AppearanceChatContrastControls
        appearance={resolveNativeChatAppearanceSettings(undefined)}
        onChange={onChange}
      />
    )
    const slider = screen.getByRole('slider', { name: 'Contrast' })
    for (const value of [110, 120, 130]) {
      fireEvent.change(slider, { target: { value } })
      expect(screen.getByText(String(value))).toBeTruthy()
      expect(onChange).not.toHaveBeenCalled()
    }
    fireEvent.pointerUp(slider)
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ contrast: 130 })
  })

  it('resets the draft when settings are changed externally', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <AppearanceChatContrastControls
        appearance={resolveNativeChatAppearanceSettings(undefined)}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByRole('slider'), { target: { value: 130 } })
    rerender(
      <AppearanceChatContrastControls
        appearance={resolveNativeChatAppearanceSettings({ contrast: 80 })}
        onChange={onChange}
      />
    )
    expect(screen.getByRole('slider').getAttribute('value')).toBe('80')
    expect(screen.getByText('80')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
  })
})
