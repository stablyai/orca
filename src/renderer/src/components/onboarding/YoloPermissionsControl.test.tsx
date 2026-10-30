// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { newChatPermissionModeForSettings } from '../../../../shared/agent-chat-permission-mode'
import { resolveTuiAgentLaunchArgs } from '../../../../shared/tui-agent-launch-defaults'
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

it('shows full-access exceptions while off and persists the action for terminals and chats', async () => {
  render(<YoloPermissionsControl yoloPermissions={false} />)

  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('status').textContent).toContain('Codex still has full access')
  expect(screen.getByRole('status').textContent).not.toContain('Claude')
  expect(resolveTuiAgentLaunchArgs('codex', saved)).toContain(
    '--dangerously-bypass-approvals-and-sandbox'
  )
  expect(newChatPermissionModeForSettings('codex', saved)).toBe('full-access')

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Use Codex’s own settings' }))
  )

  expect(screen.queryByRole('status')).toBeNull()
  expect(saved.agentPermissionOverrides).toEqual({ codex: 'own', claude: 'ask' })
  expect(resolveTuiAgentLaunchArgs('codex', saved)).not.toContain(
    '--dangerously-bypass-approvals-and-sandbox'
  )
  expect(newChatPermissionModeForSettings('codex', saved)).toBe('own')
})

it('reveals the exception when Yolo is switched off', () => {
  function Harness() {
    const [yolo, setYolo] = useState(true)
    return <YoloPermissionsControl yoloPermissions={yolo} onYoloPermissionsChange={setYolo} />
  }
  render(<Harness />)
  expect(screen.queryByRole('status')).toBeNull()

  fireEvent.click(screen.getByRole('switch'))
  expect(screen.getByRole('status').textContent).toContain('Codex still has full access')
})

it('keeps the exception visible after a failed save and lets the user retry', async () => {
  vi.mocked(window.api.settings.set).mockRejectedValueOnce(new Error('Write failed'))
  render(<YoloPermissionsControl yoloPermissions={false} />)

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Use Codex’s own settings' }))
  )

  expect(screen.getByRole('alert').textContent).toContain('Could not change permissions')
  expect(screen.getByRole('status').textContent).toContain('Codex still has full access')
  expect(newChatPermissionModeForSettings('codex', saved)).toBe('full-access')

  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Use Codex’s own settings' }))
  )

  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})
