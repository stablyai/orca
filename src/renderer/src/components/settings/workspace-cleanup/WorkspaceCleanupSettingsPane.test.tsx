// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n/I18nProvider'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  getDefaultWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPolicyPreviewRequest } from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy-change'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TooltipProvider } from '../../ui/tooltip'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'

const row: WorkspaceCleanupPreviewRow = {
  worktreeId: 'preview::/preview/landing',
  instanceId: 'landing-incarnation',
  executionHostId: 'local',
  repoId: 'preview',
  repoName: 'Website',
  displayName: 'Landing page',
  branch: 'landing',
  path: '/preview/landing',
  evaluation: { action: 'delete', reason: 'inactive' }
}
let failPreview = false
let includeCandidate = false
let pinned: string[] = []
const originalApi = window.api
const originalState = useAppStore.getState()

function Pane() {
  const settings = useAppStore((state) => state.settings)
  return (
    <WorkspaceCleanupSettingsPane
      hostScope={{ target: { kind: 'local' }, available: true }}
      settings={settings}
      updateSettings={(updates) =>
        useAppStore.setState((state) => ({ settings: { ...state.settings!, ...updates } }))
      }
    />
  )
}

async function mount(enabled = false) {
  const settings = getDefaultSettings('/preview')
  settings.workspaceCleanupPolicy = {
    ...getDefaultWorkspaceCleanupRules(),
    inactive: { enabled, afterDays: 30, action: 'delete' }
  }
  useAppStore.setState({
    settings,
    worktreesByRepo: {
      preview: [makeWorktree({ id: row.worktreeId, repoId: 'preview', isPinned: false })]
    }
  })
  render(
    <TooltipProvider>
      <I18nProvider>
        <Pane />
      </I18nProvider>
    </TooltipProvider>
  )
  await waitFor(() => expect(protection().getAttribute('aria-disabled')).toBe('false'))
}

function protection() {
  return screen.getByRole('switch', { name: 'Keep workspaces with ignored files' })
}
function confirm() {
  return screen.getByRole('button', { name: 'Turn off protection' })
}
function savedRules() {
  const rules = useAppStore.getState().settings?.workspaceCleanupPolicy
  if (!rules) {
    throw new Error('Cleanup rules are unavailable')
  }
  return rules
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 15, 12))
  failPreview = false
  includeCandidate = false
  pinned = []
  useAppStore.setState(useAppStore.getInitialState(), true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...originalApi,
      runtime: {
        ...originalApi?.runtime,
        call: async ({
          method,
          params
        }: {
          method: string
          params?: WorkspaceCleanupPolicyPreviewRequest & {
            workspaceCleanupPolicy?: WorkspaceCleanupRules
            worktreeId?: string
            rows?: { worktreeId: string; instanceId: string }[]
          }
        }) => {
          const policyRead = () => ({
            protocol: 3,
            expiresAt: Date.UTC(2026, 10, 15, 12, 10),
            state: {
              repoId: null,
              rules: structuredClone(savedRules()),
              projects: [{ id: 'preview', hostId: 'local', policy: null }]
            }
          })
          let result: unknown
          if (method === 'workspaceCleanup.policyState') {
            result = policyRead()
          } else if (method === 'workspaceCleanup.previewChange') {
            if (failPreview) {
              throw new Error('Preview unavailable')
            }
            result = {
              read: policyRead(),
              current: { evaluatedAt: 1, rows: [] },
              next: {
                evaluatedAt: 1,
                rows:
                  includeCandidate &&
                  params?.change?.scope === 'global' &&
                  params.change.rules.keepWhen === 'uncommitted'
                    ? [row]
                    : []
              }
            }
          } else if (method === 'workspaceCleanup.reservePolicyWrite') {
            result = { reserved: true }
          } else if (method === 'workspaceCleanup.pinBatch') {
            pinned.push(...params!.rows!.map((row) => row.worktreeId))
            result = { pinned: params!.rows!.map((row) => row.worktreeId), deleted: [], failed: [] }
          } else if (method === 'settings.update') {
            useAppStore.setState((state) => ({
              settings: {
                ...state.settings!,
                workspaceCleanupPolicy: params!.workspaceCleanupPolicy
              }
            }))
            result = useAppStore.getState().settings
          } else if (method === 'workspaceCleanup.report') {
            result = { runs: [], running: false, nextRunAt: null }
          } else if (method === 'workspaceCleanup.preview') {
            result = { evaluatedAt: 1, rows: [] }
          } else {
            throw new Error(`Unexpected RPC ${method}`)
          }
          return { id: 'preview', ok: true, result }
        }
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  useAppStore.setState(originalState, true)
  vi.restoreAllMocks()
})

describe('cleanup protection consent', () => {
  it('requires consent with all rules off and can save while previews are unavailable', async () => {
    failPreview = true
    await mount()
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
    await mount()
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
    expect(pinned).toEqual([])
    await act(async () => {
      fireEvent.click(confirm())
    })
    await waitFor(() => expect(savedRules().keepWhen).toBe('uncommitted'))
    expect(pinned).toEqual(['preview::/preview/landing'])
  })

  it('keeps protection and the dialog when confirmation preview fails, then allows retry', async () => {
    await mount(true)
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
