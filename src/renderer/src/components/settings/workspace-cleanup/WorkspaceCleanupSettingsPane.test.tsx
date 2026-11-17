// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import {
  getDefaultWorkspaceCleanupRules,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TooltipProvider } from '../../ui/tooltip'
import { WorkspaceCleanupSettingsPane } from './WorkspaceCleanupSettingsPane'

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

function mount(enabled = false) {
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
  render(<Pane />, { wrapper: TooltipProvider })
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
  failPreview = false
  includeCandidate = false
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
          if (method === 'workspaceCleanup.preview' && failPreview) {
            throw new Error('Preview unavailable')
          }
          return {
            id: 'preview',
            ok: true,
            result:
              method === 'workspaceCleanup.report'
                ? { runs: [], running: false, nextRunAt: null }
                : {
                    evaluatedAt: 0,
                    rows: includeCandidate && params?.rules?.keepWhen === 'uncommitted' ? [row] : []
                  }
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
