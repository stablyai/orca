// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import { YoloPermissionsControl } from './YoloPermissionsControl'

const initialState = useAppStore.getState()
const originalApi = window.api
let saved: GlobalSettings

beforeEach(() => {
  saved = {
    ...getDefaultSettings('/synthetic'),
    agentPermissionDefault: 'own',
    agentPermissionOverrides: { codex: 'full-access', claude: 'ask' }
  }
  useAppStore.setState({ settings: saved })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...originalApi,
      settings: {
        ...originalApi?.settings,
        set: vi.fn(async (updates: Partial<GlobalSettings>) => {
          saved = { ...saved, ...updates }
          return saved
        })
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  vi.restoreAllMocks()
})

it('persists only the selected agent permission override', async () => {
  render(<YoloPermissionsControl yoloPermissions={false} />)

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Use Codex’s own settings' }))
  )

  expect(screen.queryByRole('status')).toBeNull()
  expect(saved.agentPermissionOverrides).toEqual({ codex: 'own', claude: 'ask' })
})
