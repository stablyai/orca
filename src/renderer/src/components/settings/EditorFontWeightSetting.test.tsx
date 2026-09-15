// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { EditorFontWeightSetting } from './EditorFontWeightSetting'

afterEach(cleanup)

function renderSetting(
  editorFontWeight: number | undefined,
  updateSettings = vi.fn()
): { updateSettings: ReturnType<typeof vi.fn>; input: HTMLInputElement } {
  render(
    <EditorFontWeightSetting
      settings={{ terminalFontWeight: 500, editorFontWeight } as unknown as GlobalSettings}
      updateSettings={updateSettings}
    />
  )
  return {
    updateSettings,
    input: screen.getByLabelText('Editor Font Weight') as HTMLInputElement
  }
}

describe('EditorFontWeightSetting', () => {
  // Why this renders rather than asserting on a resolver: the unset state reaches
  // NumberField as a prop, and an "empty" sentinel it compares with !== (NaN) sets
  // state on every render and trips React's re-render limit. Only a render catches it.
  it('renders the inheriting state as an empty field without re-rendering forever', () => {
    const { input } = renderSetting(0)
    expect(input.value).toBe('')
    // The placeholder is the live terminal weight, so the empty row still shows what it inherits.
    expect(input.getAttribute('placeholder')).toBe('500')
  })

  it('shows the pinned weight when the editor opts out of the terminal weight', () => {
    const { input } = renderSetting(350)
    expect(input.value).toBe('350')
  })

  it('clamps a committed weight into the supported band', () => {
    const { updateSettings, input } = renderSetting(undefined)
    fireEvent.change(input, { target: { value: '5000' } })
    fireEvent.blur(input)
    expect(updateSettings).toHaveBeenCalledWith({ editorFontWeight: 900 })
  })

  it('goes back to inheriting when the field is emptied', () => {
    const { updateSettings, input } = renderSetting(350)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(updateSettings).toHaveBeenCalledWith({ editorFontWeight: 0 })
  })
})
