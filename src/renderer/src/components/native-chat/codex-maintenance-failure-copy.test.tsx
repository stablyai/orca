// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../../shared/codex-cli-installation'
import type { CodexMaintenanceState } from '../../../../shared/codex-cli-maintenance'
import {
  refreshCodexMaintenance,
  resetCodexMaintenanceStoreForTests
} from '@/lib/codex-maintenance-store'
import { CodexMaintenanceRow } from '../settings/CodexMaintenanceRow'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { CodexMaintenanceLogDialog } from './CodexMaintenanceLogDialog'

const { call, refreshAgents } = vi.hoisted(() => ({
  call: vi.fn(),
  refreshAgents: vi.fn().mockResolvedValue([])
}))
vi.mock('@/lib/codex-maintenance-client', () => ({
  callCodexMaintenance: call,
  codexMaintenanceTargetKey: (target: { kind: string; cwd?: string }) =>
    `${target.kind}:codex${target.cwd ? `:${target.cwd}` : ''}`
}))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: () => () => {},
    getState: () => ({ refreshDetectedAgents: refreshAgents })
  }
}))
const TARGET = { kind: 'local' } as const
function state(installed: boolean, version: string | null): CodexMaintenanceState {
  return {
    evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
    installation: codexCliInstallation(installed, version),
    canRun: !installed,
    job: null
  }
}
function SettingsRow() {
  return (
    <>
      <CodexMaintenanceRow target={TARGET} />
      <CodexMaintenanceLogDialog />
    </>
  )
}
beforeEach(() => {
  call.mockReset()
  resetCodexMaintenanceStoreForTests()
})
afterEach(() => {
  cleanup()
  resetCodexMaintenanceStoreForTests()
  vi.useRealTimers()
})
async function flush() {
  await act(async () => {
    await refreshCodexMaintenance(TARGET)
  })
}

import { agentSessionRefusalFailure } from '../../../../shared/agent-session-write-failure'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
describe('Codex install failure copy', () => {
  it.each([
    { error: 'spawn C:\\tools\\node.exe EACCES', exitCode: null },
    { error: 'Codex maintenance timed out.', exitCode: null },
    { error: null, exitCode: 17 }
  ])(
    'renders and copies the host diagnostic with error $error and exit $exitCode',
    async ({ error, exitCode }) => {
      const initial = state(false, null)
      const diagnostic = error ?? 'npm ERR! EACCES: permission denied'
      const output = `$ npm install -g @openai/codex\n${diagnostic}\n`
      const completed: CodexMaintenanceState = {
        ...initial,
        job: { id: 'failed', phase: 'completed', output, error, exitCode }
      }
      call.mockImplementation(async (_target, params) =>
        params.operation === 'start' ? completed : initial
      )
      const write = vi.fn().mockResolvedValue(undefined)
      Object.assign(window, { api: { ui: { writeClipboardText: write } } })
      render(<SettingsRow />)
      await flush()
      fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
      expect(
        await screen.findByText(
          error ? 'Codex could not be installed. Try again.' : 'Command exited with code 17'
        )
      ).toBeInTheDocument()
      expect(
        screen.getByText((text) => text.includes(diagnostic), { selector: 'pre' })
      ).toHaveTextContent(diagnostic)
      fireEvent.click(screen.getByRole('button', { name: 'Copy log' }))
      await waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith(output))
    }
  )
  it('keeps a raw start error out of the failure headline', async () => {
    call.mockImplementation(async (_target, params) => {
      if (params.operation === 'start') {
        throw new Error('private transport stack and host runtime details')
      }
      return state(false, null)
    })
    render(<SettingsRow />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    expect(await screen.findByText('Codex could not be installed. Try again.')).toBeInTheDocument()
    expect(screen.queryByText(/private transport stack/)).toBeNull()
  })
  it('states a too-old Codex in the start-failure notice without a button', () => {
    const notices = structuredSessionNotices({
      agentLabel: 'Codex',
      sessionError: null,
      composerError: null,
      launch: {
        lifecycle: 'failed',
        retry: vi.fn(),
        failure: agentSessionRefusalFailure({
          code: 'agent_session_operation_invalid',
          details: {
            reason: 'attachFailed',
            codexInstallation: { installedVersion: '0.135.0', minimumVersion: '0.136.0' }
          }
        })
      }
    })
    render(<NativeChatComposerNotices notices={notices} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(
      screen.getByText('Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.')
    ).toBeInTheDocument()
  })
})
