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
import { getSettingsScrollTarget } from '../navigation/settings-navigation-foundations'
import { getSettingsTitleTargetId } from '../section-layout/settings-target-highlight'
import { matchesSettingsSearch } from '../search/settings-search'
import { getWorkspaceCleanupSettingsSearchEntries } from './workspace-cleanup-settings-search'
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
let reportRunning = false

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
  reportRunning = false
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
                ? { runs: reportRuns, running: reportRunning, nextRunAt: null }
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
    expect(merged().getAttribute('aria-disabled')).toBe('true')
    expect(merged().hasAttribute('disabled')).toBe(false)
    const unchanged = screen.getByRole('switch', { name: 'Delete unchanged workspaces' })
    expect(unchanged.getAttribute('aria-disabled')).toBe('true')
    expect(unchanged.hasAttribute('disabled')).toBe(false)
    await act(async () => {
      fireEvent.click(unchanged)
      fireEvent.keyDown(merged(), { key: ' ' })
      fireEvent.click(merged())
    })
    expect(mergedCheckingLine()).not.toBeNull()

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

  it.each([
    ['off', false, false],
    ['on', true, false],
    ['running', true, true]
  ])(
    'keeps the Run rules now result pointing at the heading after the query clears, rules %s',
    async (_state, enabled, running) => {
      reportRunning = running
      mount(enabled)
      if (running) {
        await screen.findByRole('button', { name: 'Running…' })
      }
      search('run rules now')
      const results = getWorkspaceCleanupSettingsSearchEntries()
        .filter((entry) => matchesSettingsSearch('run rules now', entry))
        .map((entry) => entry.title)
      expect(results).toEqual(['Automatic cleanup'])
      const targetId = getSettingsTitleTargetId('Automatic cleanup')
      expect(getSettingsScrollTarget(targetId)).not.toBeNull()

      // Choosing a result clears the query before the page scrolls to the target.
      search('')
      const target = getSettingsScrollTarget(targetId)
      expect(target?.querySelector('[data-settings-group-heading]')?.textContent).toContain(
        'Automatic cleanup'
      )
    }
  )
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
  // The page's live regions; no rule check is running in these tests.
  function regions(): string[] {
    return screen.getAllByRole('status').map((region) => region.textContent ?? '')
  }
  // A finished-run event makes the page read the report again, as the host's event does.
  async function rereadReport(changed: () => boolean): Promise<void> {
    await act(async () => {
      const { rows: _rows, ...run } = reportRuns[0]!
      emitWorkspaceCleanupRunFinishedWindowEvent({ environmentId: null, run })
    })
    await waitFor(() => expect(changed()).toBe(true))
  }
  // Only the relative times change; nothing should be announced.
  async function refreshTimes(advance: () => void): Promise<void> {
    const line = statusLine()
    const before = regions()
    advance()
    await rereadReport(() => statusLine() !== line)
    expect(regions()).toEqual(before)
  }

  it('announces a run starting and its result, not a refresh of the relative times', async () => {
    let now = Date.UTC(2026, 10, 15, 12)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      reportRuns = [finishedRun('run-1', now - 60 * 60_000)]
      mount(true)
      await waitFor(() => expect(statusLine()).not.toBe(''))
      expect(regions()).toEqual(['', ''])
      await refreshTimes(() => (now += 2 * 60 * 60_000))

      let finishRun = (): void => {}
      runNowGate = new Promise((resolve) => (finishRun = resolve))
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run rules now' }))
      })
      const started = regions()
      expect(started.filter(Boolean)).toHaveLength(1)

      reportRuns = [finishedRun('run-2', now), ...reportRuns]
      await act(async () => {
        finishRun()
      })
      await rereadReport(() => regions().join() !== started.join())
      const finished = regions()
      // The result goes into the region that was empty, not over the start text.
      expect(finished.findIndex(Boolean)).toBe(started.indexOf(''))
      expect(finished.filter(Boolean)).toHaveLength(1)

      await refreshTimes(() => (now += 60 * 60_000))
    } finally {
      clock.mockRestore()
    }
  })

  it('announces each scheduled run, including two worded the same', async () => {
    const now = Date.UTC(2026, 10, 15, 12)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      reportRuns = [finishedRun('run-1', now - 60 * 60_000)]
      mount(true)
      await waitFor(() => expect(statusLine()).not.toBe(''))

      reportRuns = [finishedRun('run-2', now), ...reportRuns]
      await rereadReport(() => regions().some(Boolean))
      const first = regions()
      const firstSlot = first.findIndex(Boolean)
      expect(first.filter(Boolean)).toHaveLength(1)

      reportRuns = [finishedRun('run-3', now), ...reportRuns]
      await rereadReport(() => regions().join() !== first.join())
      const second = regions()
      // Same words, so the text moves to the region that was empty and is announced again.
      expect(second[firstSlot]).toBe('')
      expect(second[1 - firstSlot]).toBe(first[firstSlot])
    } finally {
      clock.mockRestore()
    }
  })
})
