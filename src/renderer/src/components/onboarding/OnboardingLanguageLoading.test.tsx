// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { markRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import { OnboardingLanguageLoading } from './OnboardingLanguageLoading'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it('releases settings recovery while remote owner hydration is still pending', async () => {
  await i18n.changeLanguage('en')
  useAppStore.setState(useAppStore.getInitialState(), true)
  markRuntimeEnvironmentCompatible('language-retry-owner')
  let finishOwnerRead: (value: unknown) => void = () => {}
  const ownerRead = new Promise((resolve) => {
    finishOwnerRead = resolve
  })
  const call = vi.fn().mockReturnValue(ownerRead)
  const settings = {
    ...getDefaultSettings('/tmp'),
    activeRuntimeEnvironmentId: 'language-retry-owner'
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      settings: { get: vi.fn().mockResolvedValue(settings) },
      runtimeEnvironments: { call, list: vi.fn().mockResolvedValue([]) }
    }
  })
  render(<OnboardingLanguageLoading />)
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expect(screen.getByRole('status').textContent).toContain('Loading settings')
  try {
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(useAppStore.getState().settings).toBe(settings)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Loading language')
  } finally {
    finishOwnerRead({
      ok: true,
      result: { settings: {} },
      _meta: { runtimeId: 'language-retry-runtime' }
    })
    await useAppStore.getState().awaitOwnerWorktreeVisibilityDefaultsHydration()
  }
})
