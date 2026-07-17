// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectDefaultPathSetting } from './ProjectDefaultPathSetting'
import type { GlobalSettings } from '../../../../shared/types'

// Only the fields the component reads matter; cast a minimal object.
function settingsWith(projectDefaultPath?: string): GlobalSettings {
  return { projectDefaultPath } as unknown as GlobalSettings
}

afterEach(() => {
  cleanup()
})

describe('ProjectDefaultPathSetting', () => {
  it('shows the saved path in the input', () => {
    render(
      <ProjectDefaultPathSetting
        settings={settingsWith('/Users/me/dev')}
        updateSettings={vi.fn()}
      />
    )
    expect(screen.getByDisplayValue('/Users/me/dev')).toBeInTheDocument()
  })

  it('commits the typed path on blur', () => {
    const updateSettings = vi.fn()
    render(
      <ProjectDefaultPathSetting settings={settingsWith('')} updateSettings={updateSettings} />
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '/Users/me/code' } })
    fireEvent.blur(input)
    expect(updateSettings).toHaveBeenCalledWith({ projectDefaultPath: '/Users/me/code' })
  })

  it('clears the setting when Reset is pressed', () => {
    const updateSettings = vi.fn()
    render(
      <ProjectDefaultPathSetting
        settings={settingsWith('/Users/me/dev')}
        updateSettings={updateSettings}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    expect(updateSettings).toHaveBeenCalledWith({ projectDefaultPath: '' })
  })

  it('exposes an accessible name on the Browse button', () => {
    render(<ProjectDefaultPathSetting settings={settingsWith('')} updateSettings={vi.fn()} />)
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument()
  })
})
