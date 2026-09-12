// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why pin the platform: Monaco's automatic ratio is 1.5 on macOS and 1.35 elsewhere,
// and that number is what the empty row shows, so the assertion needs a fixed host.
vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'darwin',
  resetRendererAppPlatformCacheForTests: vi.fn()
}))

import { EditorLineHeightSetting } from './EditorLineHeightSetting'

afterEach(cleanup)

function renderSetting(
  editorLineHeight: number | undefined,
  updateSettings = vi.fn()
): { updateSettings: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
  render(
    <EditorLineHeightSetting
      settings={{ editorLineHeight } as unknown as GlobalSettings}
      updateSettings={updateSettings}
    />
  )
  return {
    updateSettings,
    input: screen.getByLabelText('Editor Line Height') as HTMLInputElement
  }
}

describe('EditorLineHeightSetting', () => {
  it('shows Monaco automatic spacing as an empty field with its resolved ratio', () => {
    const { input } = renderSetting(0)
    expect(input.value).toBe('')
    expect(input.getAttribute('placeholder')).toBe('1.5')
  })

  it('shows the pinned multiplier once the user opts in', () => {
    const { input } = renderSetting(1.2)
    expect(input.value).toBe('1.2')
  })

  it('clamps a committed multiplier into the supported band', () => {
    const { updateSettings, input } = renderSetting(undefined)
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.blur(input)
    expect(updateSettings).toHaveBeenCalledWith({ editorLineHeight: 3 })
  })

  it('returns to automatic spacing when the field is emptied', () => {
    const { updateSettings, input } = renderSetting(1.2)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(updateSettings).toHaveBeenCalledWith({ editorLineHeight: 0 })
  })
})
