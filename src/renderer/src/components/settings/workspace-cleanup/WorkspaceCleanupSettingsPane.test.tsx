// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  getDefaultWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPreviewRow,
  WorkspaceCleanupRun
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { emitWorkspaceCleanupRunFinishedWindowEvent } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import { TooltipProvider } from '../../ui/tooltip'
import type * as RuntimeRpcCall from '@/runtime/rpc/calls/runtime-rpc-call'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'

const environmentCall = vi.hoisted(
  (): { settingsGetFails: boolean; rules: WorkspaceCleanupRules | null } => ({
    settingsGetFails: false,
    rules: null
  })
)

// A remote host's calls skip the pairing transport; local calls use window.api as the app does.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcCall>()
  return {
    ...actual,
    callRuntimeRpc: async (
      target: RuntimeClientTarget,
      method: string,
      params?: unknown,
      options?: Parameters<typeof actual.callRuntimeRpc>[3]
    ) => {
      if (target.kind !== 'environment') {
        return actual.callRuntimeRpc(target, method, params, options)
      }
      if (method === 'settings.get') {
        if (environmentCall.settingsGetFails) {
          throw new Error('Host unreachable')
        }
        return { settings: { workspaceCleanupPolicy: environmentCall.rules } }
      }
      return method === 'workspaceCleanup.report'
        ? { runs: [], running: false, nextRunAt: null }
        : { evaluatedAt: 0, rows: [] }
    }
  }
})

const row: WorkspaceCleanupPreviewRow = {
  worktreeId: 'preview::/preview/landing',
  repoId: 'preview',
  repoName: 'Website',
  displayName: 'Landing page',
  branch: 'landing',
  path: '/preview/landing',
  evaluation: { action: 'delete', reason: 'inactive' }
}
let failPreview = false
let includeCandidate = false
let matchWhenMergedOn = false
let previewGate: Promise<void> | null = null
let saveGate: Promise<void> | null = null
let runNowGate: Promise<void> | null = null
let reportRuns: WorkspaceCleanupRun[] = []

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

function Pane({ target = LOCAL_TARGET }: { target?: RuntimeClientTarget }) {
  const settings = useAppStore((state) => state.settings)
  return (
    <WorkspaceCleanupSettingsPane
      hostScope={{ target, available: true }}
      settings={settings}
      updateSettings={async (updates) => {
        await saveGate
        useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
      }}
    />
  )
}

function mount(enabled = false, target?: RuntimeClientTarget) {
  const settings = getDefaultSettings('/preview')
  settings.workspaceCleanupPolicy = {
    ...getDefaultWorkspaceCleanupRules(),
    inactive: { enabled, afterDays: 30, action: 'delete' }
  }
  environmentCall.rules = settings.workspaceCleanupPolicy
  useAppStore.setState({
    settings,
    worktreesByRepo: {
      preview: [makeWorktree({ id: row.worktreeId, repoId: 'preview', isPinned: false })]
    }
  })
  render(<Pane target={target} />, { wrapper: TooltipProvider })
}

function protection() {
  return screen.getByRole('switch', { name: 'Keep workspaces with ignored files' })
}
function confirm() {
  return screen.getByRole('button', { name: 'Turn off protection' })
}
// getByRole skips hidden elements, so finding a switch also proves it is shown.
function merged() {
  return screen.getByRole('switch', { name: 'Delete merged workspaces' })
}
function workers() {
  return screen.getByRole('switch', { name: 'Delete released orchestration worker workspaces' })
}
// The rule's own checking line, apart from the page's run announcements.
function mergedCheckingLine() {
  return merged().closest('[data-settings-row]')?.querySelector('[role="status"]') ?? null
}
function tryAgain() {
  return screen.getByRole('button', { name: 'Try again' })
}
function search(query: string) {
  act(() => useAppStore.setState({ settingsSearchQuery: query }))
}
function savedRules() {
  const rules = useAppStore.getState().settings?.workspaceCleanupPolicy
  if (!rules) {
    throw new Error('Cleanup rules are unavailable')
  }
  return rules
}

beforeEach(() => {
  failPreview = false
  includeCandidate = false
  matchWhenMergedOn = false
  previewGate = null
  saveGate = null
  runNowGate = null
  reportRuns = []
  environmentCall.settingsGetFails = false
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.assign(window, {
    api: {
      worktrees: { updateMeta: async () => {} },
      runtime: {
        call: async ({
          method,
          params
        }: {
          method: string
          params?: { rules?: WorkspaceCleanupRules }
        }) => {
          if (method === 'workspaceCleanup.runNow') {
            await runNowGate
          }
          if (method === 'workspaceCleanup.preview') {
            await previewGate
            if (failPreview) {
              throw new Error('Preview unavailable')
            }
          }
          const candidate =
            (includeCandidate && params?.rules?.keepWhen === 'uncommitted') ||
            (matchWhenMergedOn && params?.rules?.merged.enabled === true)
          return {
            id: 'preview',
            ok: true,
            result:
              method === 'workspaceCleanup.report'
                ? { runs: reportRuns, running: false, nextRunAt: null }
                : { evaluatedAt: 0, rows: candidate ? [row] : [] }
          }
        }
      }
    }
  })
})
afterEach(cleanup)

describe('cleanup protection consent', () => {
  it('requires consent with all rules off and can save while previews are unavailable', async () => {
    failPreview = true
    mount()
    await act(async () => {
      fireEvent.click(protection())
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(savedRules().keepWhen).toBe('any-local-files')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    expect(savedRules().keepWhen).toBe('any-local-files')
    await act(async () => {
      fireEvent.click(protection())
    })
    await act(async () => {
      fireEvent.click(confirm())
    })
    await waitFor(() => expect(savedRules().keepWhen).toBe('uncommitted'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reviews newly eligible workspaces after concurrent enablement and pins only after renewed consent', async () => {
    mount()
    await act(async () => {
      fireEvent.click(protection())
    })
    await act(async () => {
      useAppStore.setState((state) => ({
        settings: {
          ...state.settings!,
          workspaceCleanupPolicy: {
            ...savedRules(),
            inactive: { enabled: true, afterDays: 30, action: 'delete' }
          }
        }
      }))
    })
    includeCandidate = true
    await act(async () => {
      fireEvent.click(confirm())
    })
    const checkbox = await screen.findByRole('checkbox')
    expect(savedRules().keepWhen).toBe('any-local-files')
    await act(async () => {
      fireEvent.click(checkbox)
    })
    expect(useAppStore.getState().worktreesByRepo.preview?.[0]?.isPinned).toBe(false)
    await act(async () => {
      fireEvent.click(confirm())
    })
    await waitFor(() => expect(savedRules().keepWhen).toBe('uncommitted'))
    expect(useAppStore.getState().worktreesByRepo.preview?.[0]?.isPinned).toBe(true)
  })

  it('keeps protection and the dialog when confirmation preview fails, then allows retry', async () => {
    mount(true)
    await act(async () => {
      fireEvent.click(protection())
    })
    failPreview = true
    await act(async () => {
      fireEvent.click(confirm())
    })
    expect(savedRules().keepWhen).toBe('any-local-files')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(confirm().hasAttribute('disabled')).toBe(false)
    failPreview = false
    await act(async () => {
      fireEvent.click(confirm())
    })
    await waitFor(() => expect(savedRules().keepWhen).toBe('uncommitted'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('turning a rule on', () => {
  it('keeps the rule pending through its check and save while other rules stay focusable but held', async () => {
    let releasePreview = (): void => {}
    previewGate = new Promise((resolve) => (releasePreview = resolve))
    let releaseSave = (): void => {}
    saveGate = new Promise((resolve) => (releaseSave = resolve))
    mount()
    await act(async () => {
      fireEvent.click(merged())
    })
    expect(mergedCheckingLine()).not.toBeNull()
    expect(merged().getAttribute('aria-busy')).toBe('true')
    expect(merged().getAttribute('aria-checked')).toBe('false')
    const unchanged = screen.getByRole('switch', { name: 'Delete unchanged workspaces' })
    expect(unchanged.getAttribute('aria-disabled')).toBe('true')
    expect(unchanged.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(unchanged)
    })

    await act(async () => {
      releasePreview()
    })
    expect(mergedCheckingLine()).toBeNull()
    expect(merged().getAttribute('aria-busy')).toBe('true')
    expect(merged().getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      releaseSave()
    })
    await waitFor(() => expect(merged().getAttribute('aria-checked')).toBe('true'))
    expect(merged().hasAttribute('aria-busy')).toBe(false)
    expect(savedRules().unchanged.enabled).toBe(false)
  })

  it('shows a failed check under the rule and saves it on Try again with focus kept', async () => {
    failPreview = true
    mount()
    merged().focus()
    await act(async () => {
      fireEvent.click(merged())
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(merged().getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
    expect(savedRules().merged.enabled).toBe(false)
    expect(document.activeElement).toBe(merged())

    failPreview = false
    await act(async () => {
      fireEvent.click(tryAgain())
    })
    await waitFor(() => expect(savedRules().merged.enabled).toBe(true))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(document.activeElement).toBe(merged())
  })

  it('keeps an Advanced rule shown and focused when its retry succeeds after search moves on', async () => {
    failPreview = true
    mount()
    search('orchestration')
    workers().focus()
    await act(async () => {
      fireEvent.click(workers())
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    // A status-only search unmounts the rules; clearing it brings them back with the failure.
    search('Run rules now')
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    search('')

    failPreview = false
    await act(async () => {
      fireEvent.click(tryAgain())
    })
    await waitFor(() => expect(workers().getAttribute('aria-checked')).toBe('true'))
    expect(savedRules().orchestrationWorkers.enabled).toBe(true)
    expect(document.activeElement).toBe(workers())
  })

  it('returns focus to the rule when the confirmation a retry opened is cancelled', async () => {
    failPreview = true
    mount()
    merged().focus()
    await act(async () => {
      fireEvent.click(merged())
    })
    failPreview = false
    matchWhenMergedOn = true
    await act(async () => {
      fireEvent.click(tryAgain())
    })
    expect(await screen.findByRole('dialog')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(merged()))
    expect(savedRules().merged.enabled).toBe(false)
    expect(merged().getAttribute('aria-checked')).toBe('false')
  })

  it("shows the host's load error when its rules can't be read during a change", async () => {
    mount(false, { kind: 'environment', environmentId: 'env-1' })
    const rule = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
    environmentCall.settingsGetFails = true
    await act(async () => {
      fireEvent.click(rule)
    })
    expect(screen.queryAllByRole('switch')).toHaveLength(0)

    environmentCall.settingsGetFails = false
    await act(async () => {
      fireEvent.click(tryAgain())
    })
    const reloaded = await screen.findByRole('switch', { name: 'Delete merged workspaces' })
    expect(reloaded.getAttribute('aria-checked')).toBe('false')
    expect(reloaded.hasAttribute('aria-busy')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('automatic cleanup search', () => {
  it('shows the heading and Run rules now without the rules for a status-only search', () => {
    mount(true)
    search('Run rules now')
    expect(screen.getByRole('button', { name: 'Run rules now' })).toBeTruthy()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /Advanced/ })).toBeNull()
  })
})

describe('automatic cleanup announcements', () => {
  function finishedRun(id: string, finishedAt: number): WorkspaceCleanupRun {
    return {
      id,
      trigger: 'hourly',
      startedAt: finishedAt - 1000,
      finishedAt,
      counts: { removed: 0, archived: 0, kept: 0, failed: 0 },
      freedBytes: 0,
      rows: []
    }
  }
  function statusLine(): string {
    return document.querySelector('[data-settings-group-description]')?.textContent ?? ''
  }
  // A finished-run event makes the page read the report again, as the host's event does.
  async function rereadReport(): Promise<void> {
    const before = statusLine()
    await act(async () => {
      const { rows: _rows, ...run } = reportRuns[0]!
      emitWorkspaceCleanupRunFinishedWindowEvent({ environmentId: null, run })
    })
    await waitFor(() => expect(statusLine()).not.toBe(before))
  }

  it('announces a run starting and its result once, not each refresh of the relative times', async () => {
    let now = Date.UTC(2026, 10, 15, 12)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      reportRuns = [finishedRun('run-1', now - 60 * 60_000)]
      mount(true)
      await waitFor(() => expect(statusLine()).not.toBe(''))
      const region = screen.getByRole('status')
      expect(region.textContent).toBe('')

      now += 2 * 60 * 60_000
      await rereadReport()
      expect(region.textContent).toBe('')

      let finishRun = (): void => {}
      runNowGate = new Promise((resolve) => (finishRun = resolve))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run rules now' }))
      })
      const started = region.textContent
      expect(started).not.toBe('')

      reportRuns = [finishedRun('run-2', now), ...reportRuns]
      await act(async () => {
        finishRun()
      })
      await rereadReport()
      const finished = region.textContent
      expect(finished).not.toBe('')
      expect(finished).not.toBe(started)

      now += 60 * 60_000
      await rereadReport()
      expect(region.textContent).toBe(finished)
    } finally {
      clock.mockRestore()
    }
  })
})
