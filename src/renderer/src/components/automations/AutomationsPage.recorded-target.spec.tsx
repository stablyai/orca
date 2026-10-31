// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import { AutomationEditorDialogFooter } from './AutomationEditorDialogFooter'
import {
  api,
  mocks,
  renderPage,
  settleHostQueries,
  installAutomationsPageHarness
} from './automations-page-test-harness'
import { listedRows } from './automations-page-listed-items'
import { makeAutomation } from './automations-page-fixtures'

function hiddenRecordedTarget(enabled: boolean) {
  const saved = makeAutomation({
    enabled,
    agentId: 'codex',
    extraAgentArgs: '--model saved',
    setupDecision: 'run',
    precheck: { command: 'saved check', timeoutSeconds: 30 },
    runContext: {
      kind: 'workspace-run',
      projectId: 'logical-project',
      repoId: 'hidden-repo',
      hostId: 'ssh:builder',
      path: '/saved/physical',
      projectHostSetupId: 'saved-setup'
    },
    projectId: 'hidden-repo',
    baseBranch: 'saved/base',
    timezone: 'Pacific/Chatham'
  })
  mocks.state.repos = []
  mocks.repoMap = new Map()
  mocks.state.worktreesByRepo = {}
  mocks.state.projectHostSetups = []
  mocks.state.sshTargetLabels = new Map([['builder', 'Builder']])
  mocks.state.sshTargetGenerations = new Map([['builder', 7]])
  mocks.state.sshConnectionStates = new Map([['builder', { status: 'connected' }]])
  api.automations.list.mockResolvedValue([saved])
  api.automations.listScoped.mockImplementation(async ({ selector }) => ({
    automations: selector.kind === 'orphan' ? [saved] : [],
    items:
      selector.kind === 'orphan'
        ? [
            {
              automationId: saved.id,
              selector: { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.hostReselection }
            }
          ]
        : [],
    orphanCount: 1
  }))
  api.automations.update.mockResolvedValue(saved)
  return saved
}

describe('recorded automation target without visible projects', () => {
  installAutomationsPageHarness()
  afterEach(cleanup)
  it.each([true, false])(
    'saves only a name through the real footer (enabled=%s)',
    async (enabled) => {
      const saved = hiddenRecordedTarget(enabled)
      await renderPage()
      await settleHostQueries()
      const row = listedRows().find((candidate) => candidate.automation.id === saved.id)
      if (!row) {
        throw new Error('Missing recorded automation')
      }
      await act(async () => {
        await mocks.listPanel?.openEditDialog(row)
      })
      await act(async () => {
        mocks.editorDialog?.onDraftChange((current) => {
          if (!current || typeof current !== 'object') {
            throw new Error('Missing draft')
          }
          return { ...current, name: 'Metadata only' }
        })
      })
      const editor = mocks.editorDialog
      if (!editor) {
        throw new Error('Missing editor')
      }
      expect(editor.repos).toEqual([])
      expect(editor.draft).toMatchObject({ projectId: saved.projectId, workspaceId: '' })
      render(
        createElement(AutomationEditorDialogFooter, {
          isEditing: true,
          isSaving: false,
          canSave: !!editor.canSave,
          hasProjects: false,
          onOpenChange: () => {},
          onSave: editor.onSave
        })
      )
      const button = screen.getByRole('button', { name: 'Save Changes' })
      expect(button.hasAttribute('disabled')).toBe(false)
      await act(async () => {
        fireEvent.click(button)
      })
      await settleHostQueries()
      expect(api.automations.update).toHaveBeenCalledExactlyOnceWith({
        id: saved.id,
        expectedOwner: { selector: { kind: 'orphan' } },
        destination: undefined,
        updates: { name: 'Metadata only' }
      })
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(api.automations.delete).not.toHaveBeenCalled()
      expect(api.automations.runNow).not.toHaveBeenCalled()
      expect(mocks.toastError).not.toHaveBeenCalled()
    }
  )

  it('proposes the exact original target after explicit registered-host selection without a catalog Repo', async () => {
    const saved = hiddenRecordedTarget(false)
    await renderPage()
    await settleHostQueries()
    const row = listedRows().find((candidate) => candidate.automation.id === saved.id)
    if (!row) {
      throw new Error('Missing recorded automation')
    }
    await act(async () => {
      await mocks.listPanel?.openEditDialog(row)
    })
    const originalDraft = structuredClone(mocks.editorDialog?.draft)
    await act(async () => {
      mocks.editorDialog?.onProjectChange(saved.projectId)
    })
    expect(mocks.editorDialog?.draft).toEqual(originalDraft)
    const entry = mocks.editorDialog?.editDestination?.entries.find(
      (candidate) =>
        candidate.stableRef.selector.kind === 'ssh' &&
        candidate.stableRef.selector.targetId === 'builder'
    )
    if (!entry) {
      throw new Error('Missing registered host')
    }
    await act(async () => {
      mocks.editorDialog?.editDestination?.onSelect(entry.stableKey)
    })
    await act(async () => {
      mocks.editorDialog?.onProjectChange(saved.projectId)
    })
    expect(mocks.editorDialog?.draft).toEqual(originalDraft)
    expect(mocks.editorDialog?.draft).toMatchObject({ projectId: saved.projectId, workspaceId: '' })
    expect(mocks.editorDialog?.editDestination?.recordedProject).toEqual({
      id: saved.projectId,
      label: saved.runContext!.path
    })
    expect(mocks.editorDialog?.repos).toEqual([])
    expect(screen.queryByTestId('automation-create-no-projects')).toBeNull()
    await act(async () => {
      await mocks.editorDialog?.onSave()
    })
    await settleHostQueries()
    expect(api.automations.update).toHaveBeenCalledExactlyOnceWith({
      id: saved.id,
      expectedOwner: { selector: { kind: 'orphan' } },
      destination: { selector: { kind: 'ssh', targetId: 'builder', targetGeneration: 7 } },
      updates: {
        repo: `id:${saved.projectId}`,
        workspaceMode: saved.workspaceMode,
        workspace: undefined,
        runContext: saved.runContext
      }
    })
    expect(api.automations.create).not.toHaveBeenCalled()
    expect(api.automations.delete).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
  it.each(['wrong-host', 'wrong-project'] as const)(
    'keeps the empty-project warning when the recorded repair choice is invalid (%s)',
    async (invalid) => {
      const saved = hiddenRecordedTarget(false)
      await renderPage()
      await settleHostQueries()
      const row = listedRows().find((candidate) => candidate.automation.id === saved.id)
      if (!row) {
        throw new Error('Missing recorded automation')
      }
      await act(async () => {
        await mocks.listPanel?.openEditDialog(row)
      })
      const entry = mocks.editorDialog?.editDestination?.entries.find(
        (candidate) =>
          candidate.stableRef.selector.kind === (invalid === 'wrong-host' ? 'self' : 'ssh')
      )
      if (!entry) {
        throw new Error('Missing host')
      }
      await act(async () => {
        mocks.editorDialog?.editDestination?.onSelect(entry.stableKey)
      })
      if (invalid === 'wrong-project') {
        await act(async () => {
          mocks.editorDialog?.onDraftChange((current) => {
            if (!current || typeof current !== 'object') {
              throw new Error('Missing draft')
            }
            return { ...current, projectId: 'not-the-recorded-project' }
          })
        })
      }
      expect(mocks.editorDialog?.editDestination?.recordedProject).toBeUndefined()
      expect(screen.getByTestId('automation-create-no-projects').textContent).toContain(
        'No projects'
      )
      await act(async () => {
        await mocks.editorDialog?.onSave()
      })
      expect(api.automations.update).not.toHaveBeenCalled()
      expect(api.automations.create).not.toHaveBeenCalled()
      expect(api.automations.runNow).not.toHaveBeenCalled()
    }
  )
})
