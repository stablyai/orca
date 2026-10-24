// @vitest-environment happy-dom

import { useCallback, useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AutomationDraft } from './AutomationEditorDialog'
import { makeWorktree } from './automations-page-fixtures'
import { useAutomationDraftEffects } from './use-automation-draft-effects'

type HookInput = Parameters<typeof useAutomationDraftEffects>[0]

type HarnessProps = {
  initialDraft: AutomationDraft
  editingAutomationId: string | null
  worktrees: HookInput['destinationForm']['dialogWorktrees']
  policyDefault: AutomationDraft['setupDecision']
  defaultTarget: { projectId: string; workspaceId: string }
}

function draft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    name: 'Nightly',
    prompt: 'Run the nightly sweep',
    agentId: 'claude',
    extraAgentArgs: '',
    projectId: 'repo-1',
    workspaceMode: 'new_per_run',
    workspaceId: '',
    baseBranch: '',
    setupDecision: undefined,
    reuseSession: false,
    precheckCommand: '',
    precheckTimeoutSeconds: '60',
    preset: 'weekdays',
    time: '09:00',
    dayOfWeek: '1',
    customSchedule: '',
    savedSchedule: null,
    missedRunGraceMinutes: '720',
    scheduleWarning: null,
    ...overrides
  }
}

function props(overrides: Partial<HarnessProps> = {}): HarnessProps {
  return {
    initialDraft: draft(),
    editingAutomationId: null,
    worktrees: [],
    policyDefault: undefined,
    defaultTarget: { projectId: '', workspaceId: '' },
    ...overrides
  }
}

function useDraftHarness(input: HarnessProps) {
  const [currentDraft, setDraft] = useState(input.initialDraft)
  const [draftAtOpen, setDraftAtOpen] = useState<AutomationDraft | null>(input.initialDraft)
  const setupDecisionPolicyDefaultRef = useRef<AutomationDraft['setupDecision']>(undefined)
  const setupDecisionDefaultSignatureRef = useRef<string | null>(null)
  const setupDecisionTouchedRef = useRef(false)
  const getDraftSetupDecisionDefault = useCallback<
    HookInput['setup']['getDraftSetupDecisionDefault']
  >(
    (candidate) => (candidate.workspaceMode === 'new_per_run' ? input.policyDefault : undefined),
    [input.policyDefault]
  )
  const getDraftSetupDecisionDefaultSignature = useCallback<
    HookInput['setup']['getDraftSetupDecisionDefaultSignature']
  >(
    (candidate) =>
      `${candidate.projectId}:${candidate.workspaceMode}:${getDraftSetupDecisionDefault(candidate) ?? 'none'}`,
    [getDraftSetupDecisionDefault]
  )
  const getDefaultTarget = useCallback(() => input.defaultTarget, [input.defaultTarget])
  const local: HookInput['local'] = {
    draft: currentDraft,
    setDraft,
    setDraftAtOpen,
    createOpen: true,
    editingAutomationId: input.editingAutomationId,
    setupDecisionPolicyDefaultRef,
    setupDecisionDefaultSignatureRef,
    setupDecisionTouchedRef
  }
  const setup: HookInput['setup'] = {
    loadAutomationYamlHooksForRepo: async () => null,
    getDraftSetupDecisionDefault,
    getDraftSetupDecisionDefaultSignature
  }

  useAutomationDraftEffects({
    local,
    setup,
    destination: { createDestinationHostId: undefined },
    destinationForm: { dialogWorktrees: input.worktrees },
    pageRefresh: { getDefaultTarget }
  })

  return {
    draft: currentDraft,
    draftAtOpen,
    setDraft,
    hasUnsavedChanges:
      draftAtOpen !== null && JSON.stringify(currentDraft) !== JSON.stringify(draftAtOpen)
  }
}

afterEach(cleanup)

describe('automation draft automatic defaults and dirty baseline', () => {
  it.each([null, 'automation-1'])(
    'keeps late workspace and setup defaults clean when editing id is %s',
    (editingAutomationId) => {
      const initialProps = props({ editingAutomationId })
      const { result, rerender } = renderHook(useDraftHarness, { initialProps })

      expect(result.current.hasUnsavedChanges).toBe(false)

      rerender({
        ...initialProps,
        worktrees: [makeWorktree()],
        policyDefault: 'run'
      })

      expect(result.current.draft).toMatchObject({
        workspaceId: 'workspace-1',
        setupDecision: 'run'
      })
      expect(result.current.draftAtOpen).toEqual(result.current.draft)
      expect(result.current.hasUnsavedChanges).toBe(false)
    }
  )

  it.each([null, 'automation-1'])(
    'preserves a user rename through workspace and setup hydration when editing id is %s',
    (editingAutomationId) => {
      const initialProps = props({ editingAutomationId })
      const { result, rerender } = renderHook(useDraftHarness, { initialProps })

      act(() => result.current.setDraft((current) => ({ ...current, name: 'User name' })))
      expect(result.current.hasUnsavedChanges).toBe(true)

      rerender({
        ...initialProps,
        worktrees: [makeWorktree()],
        policyDefault: 'run'
      })

      expect(result.current.draft).toMatchObject({
        name: 'User name',
        workspaceId: 'workspace-1',
        setupDecision: 'run'
      })
      expect(result.current.draftAtOpen).toMatchObject({
        name: 'Nightly',
        workspaceId: 'workspace-1',
        setupDecision: 'run'
      })
      expect(result.current.hasUnsavedChanges).toBe(true)

      act(() => result.current.setDraft((current) => ({ ...current, name: 'Nightly' })))
      expect(result.current.hasUnsavedChanges).toBe(false)
    }
  )

  it('synchronizes a late default project without absorbing a user rename', () => {
    const initialProps = props({ initialDraft: draft({ projectId: '' }) })
    const { result, rerender } = renderHook(useDraftHarness, { initialProps })

    act(() => result.current.setDraft((current) => ({ ...current, name: 'User name' })))
    rerender({
      ...initialProps,
      defaultTarget: { projectId: 'repo-1', workspaceId: 'workspace-1' }
    })

    expect(result.current.draft).toMatchObject({
      name: 'User name',
      projectId: 'repo-1',
      workspaceId: 'workspace-1'
    })
    expect(result.current.draftAtOpen).toMatchObject({
      name: 'Nightly',
      projectId: 'repo-1',
      workspaceId: 'workspace-1'
    })
    expect(result.current.hasUnsavedChanges).toBe(true)

    act(() => result.current.setDraft((current) => ({ ...current, name: 'Nightly' })))
    expect(result.current.hasUnsavedChanges).toBe(false)
  })

  it('preserves the original project workspace and setup baseline after a user project change', () => {
    const initialDraft = draft({ workspaceId: 'workspace-1', setupDecision: 'skip' })
    const initialProps = props({ initialDraft, policyDefault: 'skip' })
    const { result, rerender } = renderHook(useDraftHarness, { initialProps })

    act(() => {
      result.current.setDraft((current) => ({
        ...current,
        projectId: 'repo-2',
        workspaceId: '',
        setupDecision: undefined
      }))
      rerender({
        ...initialProps,
        worktrees: [makeWorktree({ id: 'workspace-2', repoId: 'repo-2' })],
        policyDefault: 'run'
      })
    })

    expect(result.current.draft).toMatchObject({
      projectId: 'repo-2',
      workspaceId: 'workspace-2',
      setupDecision: 'run'
    })
    expect(result.current.draftAtOpen).toEqual(initialDraft)
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('preserves the original workspace baseline when the user clears its selection', () => {
    const initialDraft = draft({ workspaceId: 'workspace-1' })
    const { result } = renderHook(useDraftHarness, {
      initialProps: props({
        initialDraft,
        worktrees: [makeWorktree({ id: 'workspace-2' })]
      })
    })

    act(() => result.current.setDraft((current) => ({ ...current, workspaceId: '' })))

    expect(result.current.draft.workspaceId).toBe('workspace-2')
    expect(result.current.draftAtOpen).toEqual(initialDraft)
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('keeps the original project baseline when a cleared project receives a default', () => {
    const initialDraft = draft({ workspaceId: 'workspace-1' })
    const { result } = renderHook(useDraftHarness, {
      initialProps: props({
        initialDraft,
        defaultTarget: { projectId: 'repo-2', workspaceId: 'workspace-2' }
      })
    })

    act(() =>
      result.current.setDraft((current) => ({ ...current, projectId: '', workspaceId: '' }))
    )

    expect(result.current.draft).toMatchObject({
      projectId: 'repo-2',
      workspaceId: 'workspace-2'
    })
    expect(result.current.draftAtOpen).toEqual(initialDraft)
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('keeps the saved setup decision when the user clears it before defaults apply', () => {
    const initialDraft = draft({ setupDecision: 'run' })
    const { result } = renderHook(useDraftHarness, {
      initialProps: props({ initialDraft, policyDefault: 'skip' })
    })

    act(() => result.current.setDraft((current) => ({ ...current, setupDecision: undefined })))

    expect(result.current.draft.setupDecision).toBe('skip')
    expect(result.current.draftAtOpen).toEqual(initialDraft)
    expect(result.current.hasUnsavedChanges).toBe(true)
  })

  it('does not absorb a user workspace mode change into the setup baseline', () => {
    const initialDraft = draft({ workspaceMode: 'existing', workspaceId: 'workspace-1' })
    const { result } = renderHook(useDraftHarness, {
      initialProps: props({ initialDraft, policyDefault: 'run' })
    })

    act(() => result.current.setDraft((current) => ({ ...current, workspaceMode: 'new_per_run' })))

    expect(result.current.draft).toMatchObject({
      workspaceMode: 'new_per_run',
      setupDecision: 'run'
    })
    expect(result.current.draftAtOpen).toEqual(initialDraft)
    expect(result.current.hasUnsavedChanges).toBe(true)

    act(() => result.current.setDraft((current) => ({ ...current, workspaceMode: 'existing' })))

    expect(result.current.draft.setupDecision).toBeUndefined()
    expect(result.current.hasUnsavedChanges).toBe(false)
  })
})
