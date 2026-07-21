// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectDefaultPathSetting } from './ProjectDefaultPathSetting'
import type { GlobalSettings } from '../../../../shared/types'

// Only the fields the component reads matter; cast a minimal object.
function settingsWith(projectDefaultPath?: string): GlobalSettings {
  return { projectDefaultPath } as unknown as GlobalSettings
}

beforeEach(() => {
  // The component reads window.api.platform.get() to pick a platform-aware
  // placeholder; stub the minimal surface it touches.
  ;(window as unknown as { api: unknown }).api = {
    platform: { get: () => ({ platform: 'darwin', osRelease: '', displayServer: null }) },
    repos: { pickFolder: vi.fn() }
  }
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

  it('resets without committing the edited draft during button focus', () => {
    const updateSettings = vi.fn()
    render(
      <ProjectDefaultPathSetting
        settings={settingsWith('/Users/me/dev')}
        updateSettings={updateSettings}
      />
    )
    const input = screen.getByRole('textbox')
    const reset = screen.getByRole('button', { name: /reset/i })
    fireEvent.change(input, { target: { value: '/Users/me/edited' } })
    fireEvent.pointerDown(reset)
    fireEvent.blur(input)
    fireEvent.click(reset)
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(updateSettings).toHaveBeenCalledWith({ projectDefaultPath: '' })
  })

  it('seeds Browse from the draft and commits the selected directory', async () => {
    const updateSettings = vi.fn()
    vi.mocked(window.api.repos.pickFolder).mockResolvedValue('/Users/me/selected')
    render(
      <ProjectDefaultPathSetting settings={settingsWith('')} updateSettings={updateSettings} />
    )
    const input = screen.getByRole('textbox')
    const browse = screen.getByRole('button', { name: /browse/i })
    fireEvent.change(input, { target: { value: '/Users/me/draft' } })
    fireEvent.pointerDown(browse)
    fireEvent.blur(input)
    fireEvent.click(browse)

    expect(window.api.repos.pickFolder).toHaveBeenCalledWith({
      defaultPath: '/Users/me/draft'
    })
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledOnce()
      expect(updateSettings).toHaveBeenCalledWith({ projectDefaultPath: '/Users/me/selected' })
    })
  })
})
