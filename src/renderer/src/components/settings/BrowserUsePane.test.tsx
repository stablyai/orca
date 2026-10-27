// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BROWSER_USE_ENABLED_STORAGE_KEY } from '@/lib/browser-use-setup-state'
import { BrowserUseSetup } from './BrowserUsePane'

const state = vi.hoisted(
  (): {
    settingsSearchQuery: string
    browserSessionProfiles: []
    fetchBrowserSessionProfiles: () => void
    browserSessionImportState: { profileId: string; status: 'importing' } | null
    detectedBrowsers: []
    fetchDetectedBrowsers: () => void
  } => ({
    settingsSearchQuery: '',
    browserSessionProfiles: [],
    fetchBrowserSessionProfiles: vi.fn(),
    browserSessionImportState: null,
    detectedBrowsers: [],
    fetchDetectedBrowsers: vi.fn()
  })
)

vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ installDisabledReason: null })
}))
vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))
vi.mock('./BrowserUseSkillStep', () => ({ BrowserUseSkillStep: () => null }))
vi.mock('./BrowserUseExamples', () => ({ BrowserUseExamples: () => null }))

afterEach(() => {
  cleanup()
  localStorage.removeItem(BROWSER_USE_ENABLED_STORAGE_KEY)
  state.browserSessionImportState = null
})

it('shows cookie import as available before skill setup and disables it during import', () => {
  localStorage.setItem(BROWSER_USE_ENABLED_STORAGE_KEY, '1')
  const { rerender } = render(<BrowserUseSetup />)
  const importButton = screen.getByRole('button', { name: 'Import' })

  expect(importButton.hasAttribute('disabled')).toBe(false)
  expect(importButton.closest('.opacity-60')).toBeNull()

  state.browserSessionImportState = { profileId: 'default', status: 'importing' }
  rerender(<BrowserUseSetup />)
  expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true)
})
