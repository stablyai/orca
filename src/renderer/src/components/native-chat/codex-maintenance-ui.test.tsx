// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexCliInstallation } from '../../../../shared/codex-cli-installation'
import type { CodexMaintenanceState } from '../../../../shared/codex-cli-maintenance'
import type { CodexMaintenanceTarget } from '@/lib/codex-maintenance-client'
import { useCodexMaintenance } from '@/hooks/useCodexMaintenance'
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
const TOO_OLD = 'Codex 0.135.0 is too old for chats. Update to 0.136.0 or newer.'
function state(installed: boolean, version: string | null): CodexMaintenanceState {
  return {
    evidence: { expiresAt: Date.now() + 30_000, configurationId: 'config' },
    installation: codexCliInstallation(installed, version),
    canRun: !installed,
    job: null
  }
}
function Composer({ target = TARGET }: { target?: CodexMaintenanceTarget } = {}) {
  const maintenance = useCodexMaintenance(target)
  return (
    <>
      <NativeChatComposerNotices notices={maintenance.notice ? [maintenance.notice] : []} />
      <button disabled={maintenance.blocked}>Send</button>
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

describe('Codex composer and Settings maintenance', () => {
  it('does not block on a completed installation response from a host whose contact is down', async () => {
    call.mockResolvedValue(state(true, '0.135.0'))
    const target = { kind: 'environment', environmentId: 'offline' } as const
    render(<Composer target={target} />)
    await act(async () => {
      await refreshCodexMaintenance(target)
    })
    expect(screen.getByText('Send')).toBeEnabled()
    expect(screen.queryByText(TOO_OLD)).not.toBeInTheDocument()
  })

  it.each([
    { installed: false, version: null, text: "Codex isn't installed." },
    { installed: true, version: '0.135.0', text: TOO_OLD },
    { installed: true, version: null, text: null },
    { installed: true, version: '0.136.0', text: null }
  ])('renders known installation facts, allows unknown: $version / $installed', async (f) => {
    call.mockResolvedValue(state(f.installed, f.version))
    render(<Composer />)
    await flush()
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', !!f.text)
    if (f.text) {
      expect(screen.getByText(f.text)).toBeInTheDocument()
    } else {
      expect(screen.queryByRole('listitem')).toBeNull()
    }
    // Install Codex lives only in Settings; the composer states the fact.
    expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual(['Send'])
  })
  it('allows a response without current evidence', async () => {
    const legacy = state(true, '0.135.0')
    delete legacy.evidence
    call.mockResolvedValue(legacy)
    render(<Composer />)
    await flush()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    expect(screen.queryByText(TOO_OLD)).toBeNull()
  })
  it.each([
    { installed: false, version: null, text: "Codex isn't installed.", install: true },
    { installed: true, version: '0.135.0', text: TOO_OLD, install: false },
    { installed: true, version: null, text: null, install: false },
    { installed: true, version: '0.136.0', text: null, install: false }
  ])('shows the same facts in the existing Settings row: $version / $installed', async (f) => {
    call.mockResolvedValue(state(f.installed, f.version))
    const view = render(<CodexMaintenanceRow target={TARGET} />)
    await flush()
    if (f.text) {
      expect(screen.getByText(f.text)).toBeInTheDocument()
      expect(screen.queryAllByRole('button').map((button) => button.textContent)).toEqual(
        f.install ? ['Install Codex'] : []
      )
    } else {
      expect(view.container.textContent).toBe('')
    }
  })
  it('joins a shared host job, shows busy labels and streams a failure log with its exit code', async () => {
    const initial = state(false, null)
    const running: CodexMaintenanceState = {
      ...initial,
      job: {
        id: 'job',
        phase: 'running',
        output: '$ npm install -g @openai/codex\nstarted\n',
        exitCode: null,
        error: null
      }
    }
    const failed: CodexMaintenanceState = {
      ...running,
      currentJob: null,
      job: {
        ...running.job!,
        phase: 'completed',
        output: `${running.job!.output}permission denied\n`,
        exitCode: 7,
        error: null
      }
    }
    call.mockImplementation(async (_target, params) =>
      params.operation === 'status' ? initial : params.operation === 'start' ? running : failed
    )
    render(
      <>
        <Composer target={{ kind: 'local', cwd: '/project' }} />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    await waitFor(() =>
      expect(screen.getAllByText('Installing…', { selector: 'button' })).toHaveLength(1)
    )
    expect(screen.getByText(/started/)).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText('Command exited with code 7')).toBeInTheDocument(),
      { timeout: 3000 }
    )
    expect(screen.getByText(/permission denied/)).toBeInTheDocument()
    expect(call.mock.calls.filter(([, p]) => p.operation === 'start')).toHaveLength(1)
  })
  it('clears both notices after successful host verification', async () => {
    const initial = state(false, null)
    const running: CodexMaintenanceState = {
      ...initial,
      job: {
        id: 'job',
        phase: 'running',
        output: 'installing',
        exitCode: null,
        error: null
      }
    }
    const complete: CodexMaintenanceState = {
      ...state(true, '0.136.0'),
      currentJob: null,
      job: { ...running.job!, phase: 'completed', exitCode: 0 }
    }
    call.mockImplementation(async (_target, params) =>
      params.operation === 'status' ? initial : params.operation === 'start' ? running : complete
    )
    render(
      <>
        <Composer />
        <CodexMaintenanceRow target={TARGET} />
      </>
    )
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Install Codex' }))
    await waitFor(
      () => expect(screen.getByText('Command exited with code 0')).toBeInTheDocument(),
      { timeout: 3000 }
    )
    expect(screen.queryByText("Codex isn't installed.")).toBeNull()
    expect(screen.getByText('Send', { selector: 'button' })).toBeEnabled()
  })
  it('withholds a cached refusal on remount, focus revalidation and failed contact', async () => {
    call.mockResolvedValue(state(true, '0.135.0'))
    const first = render(<Composer />)
    await flush()
    expect(screen.getByText(TOO_OLD)).toBeInTheDocument()
    first.unmount()
    let rejectRead: (error: Error) => void = () => {}
    call.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject
        })
    )
    render(<Composer />)
    expect(screen.queryByText(TOO_OLD)).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await act(async () => {
      rejectRead(new Error('Host unavailable'))
    })
    expect(screen.queryByText(TOO_OLD)).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    call.mockResolvedValue(state(true, '0.135.0'))
    await flush()
    expect(screen.getByText(TOO_OLD)).toBeInTheDocument()
    let completeRead: (value: CodexMaintenanceState) => void = () => {}
    call.mockImplementation(
      () =>
        new Promise<CodexMaintenanceState>((resolve) => {
          completeRead = resolve
        })
    )
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.queryByText(TOO_OLD)).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    await act(async () => {
      completeRead(state(true, '0.136.0'))
    })
    expect(screen.queryByText(TOO_OLD)).toBeNull()
  })
})
