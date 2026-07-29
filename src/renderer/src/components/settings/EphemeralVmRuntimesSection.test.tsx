// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import {
  EphemeralVmRuntimesSection,
  getEphemeralVmRuntimeStatusLabel,
  getVisibleEphemeralVmRuntimes
} from './EphemeralVmRuntimesSection'

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    success: toastMocks.success,
    error: toastMocks.error
  }
}))

const roots: Root[] = []

function makeRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    projectId: 'project-1',
    workspaceName: 'Fix Login Race',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'orca://pair?code=test',
      projectRoot: '/workspace/repo'
    },
    ...overrides
  }
}

async function renderSection(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<EphemeralVmRuntimesSection />)
  })
  return container
}

describe('EphemeralVmRuntimesSection helpers', () => {
  it('hides cleaned runtimes and sorts active runtimes newest first', () => {
    expect(
      getVisibleEphemeralVmRuntimes([
        makeRuntime({ id: 'old', createdAt: 1 }),
        makeRuntime({ id: 'cleaned', status: 'cleaned', cleanupStatus: 'succeeded', createdAt: 3 }),
        makeRuntime({ id: 'new', createdAt: 2 })
      ]).map((runtime) => runtime.id)
    ).toEqual(['new', 'old'])
  })

  it('prioritizes cleanup status in the visible label', () => {
    expect(getEphemeralVmRuntimeStatusLabel(makeRuntime())).toBe('Running')
    expect(getEphemeralVmRuntimeStatusLabel(makeRuntime({ cleanupStatus: 'failed' }))).toBe(
      'Cleanup failed'
    )
    expect(getEphemeralVmRuntimeStatusLabel(makeRuntime({ cleanupStatus: 'disabled' }))).toBe(
      'Cleanup disabled'
    )
  })
})

describe('EphemeralVmRuntimesSection', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    toastMocks.success.mockClear()
    toastMocks.error.mockClear()
    globalThis.window = {
      api: {
        ephemeralVm: {
          listRuntimes: vi.fn().mockResolvedValue([makeRuntime()]),
          getCleanupCommand: vi.fn().mockResolvedValue({
            runtimeId: 'runtime-1',
            command:
              'node -e \'process.stdout.write(Buffer.from("e30K", "base64").toString("utf8"))\' | ./cleanup.sh',
            payloadJson: '{}',
            cleanupDisabled: false
          }),
          cleanup: vi.fn().mockResolvedValue(
            makeRuntime({
              status: 'cleaned',
              cleanupStatus: 'succeeded'
            })
          )
        },
        ui: {
          writeClipboardText: vi.fn().mockResolvedValue(undefined)
        }
      }
    } as never
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('renders active temporary VM runtimes and cleans one up', async () => {
    const container = await renderSection()

    await vi.waitFor(() => expect(container.textContent).toContain('Fix Login Race'))
    expect(container.textContent).toContain('/workspace/repo')

    const cleanupButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cleanup'
    )
    expect(cleanupButton).toBeDefined()
    await act(async () => {
      cleanupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.api.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
    await vi.waitFor(() => expect(toastMocks.success).toHaveBeenCalled())
  })

  it('shows the empty state when no runtime needs cleanup', async () => {
    window.api.ephemeralVm.listRuntimes = vi
      .fn()
      .mockResolvedValue([makeRuntime({ status: 'cleaned', cleanupStatus: 'succeeded' })])

    const container = await renderSection()

    await vi.waitFor(() =>
      expect(container.textContent).toContain('No temporary VM runtimes need cleanup.')
    )
  })

  it('surfaces cleanup hook failures returned by the cleanup IPC', async () => {
    window.api.ephemeralVm.cleanup = vi.fn().mockResolvedValue(
      makeRuntime({
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastError: 'provider delete failed'
      })
    )
    const container = await renderSection()

    await vi.waitFor(() => expect(container.textContent).toContain('Fix Login Race'))
    const cleanupButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cleanup'
    )
    await act(async () => {
      cleanupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await vi.waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith('provider delete failed'))
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  it('copies a manual cleanup command for failed runtimes', async () => {
    window.api.ephemeralVm.listRuntimes = vi.fn().mockResolvedValue([
      makeRuntime({
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastError: 'provider delete failed'
      })
    ])
    const container = await renderSection()

    await vi.waitFor(() => expect(container.textContent).toContain('Copy command'))
    const copyButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Copy command'
    )
    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.api.ephemeralVm.getCleanupCommand).toHaveBeenCalledWith({
      runtimeId: 'runtime-1'
    })
    expect(window.api.ui.writeClipboardText).toHaveBeenCalledWith(
      expect.stringContaining('Cleanup payload:')
    )
    expect(toastMocks.success).toHaveBeenCalledWith('Copied cleanup command.')
  })
})
