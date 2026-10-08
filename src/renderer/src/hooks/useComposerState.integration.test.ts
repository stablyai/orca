// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useComposerState } from './useComposerState'
import * as publicComposerDecisions from './useComposerState'
import * as composerDecisions from './composer-state/composer-decisions'

let originalApiDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const ui = {
    onFileDrop: vi.fn<Window['api']['ui']['onFileDrop']>()
  } satisfies Pick<Window['api']['ui'], 'onFileDrop'>
  const preflight = {
    detectAgents: vi.fn<Window['api']['preflight']['detectAgents']>().mockResolvedValue([])
  } satisfies Pick<Window['api']['preflight'], 'detectAgents'>
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { preflight, ui }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('useComposerState integrated lifecycle', () => {
  it('keeps the public composer decisions bound to the canonical decision module', () => {
    expect(publicComposerDecisions.canResolveFolderSmartGitHubSubmit).toBe(
      composerDecisions.canResolveFolderSmartGitHubSubmit
    )
    expect(publicComposerDecisions.getInitialAutoManagedWorkspaceName).toBe(
      composerDecisions.getInitialAutoManagedWorkspaceName
    )
    expect(publicComposerDecisions.getInitialGitHubPrStartPointSelection).toBe(
      composerDecisions.getInitialGitHubPrStartPointSelection
    )
    expect(publicComposerDecisions.getMatchingLinkedTaskSourceContext).toBe(
      composerDecisions.getMatchingLinkedTaskSourceContext
    )
    expect(publicComposerDecisions.isExplicitWorkspaceNameInput).toBe(
      composerDecisions.isExplicitWorkspaceNameInput
    )
    expect(publicComposerDecisions.resolveInitialWorkspaceRunSeed).toBe(
      composerDecisions.resolveInitialWorkspaceRunSeed
    )
    expect(publicComposerDecisions.resolveSmartGitHubCreateNames).toBe(
      composerDecisions.resolveSmartGitHubCreateNames
    )
    expect(publicComposerDecisions.retargetGitHubPrStartPointSelection).toBe(
      composerDecisions.retargetGitHubPrStartPointSelection
    )
  })

  it('composes two live composers and exposes the parent-worktree control state', () => {
    useAppStore.setState({
      repos: [],
      projects: [],
      projectGroups: [],
      projectHostSetups: [],
      newWorkspaceDraft: null,
      worktreesByRepo: {},
      sparsePresetsByRepo: {}
    })
    const first = renderHook(() => useComposerState({ initialName: 'first', persistDraft: false }))
    const second = renderHook(() =>
      useComposerState({ initialName: 'second', persistDraft: false })
    )

    expect(first.result.current.cardProps.name).toBe('first')
    expect(second.result.current.cardProps.name).toBe('second')
    expect(first.result.current.cardProps.parentWorktreeId).toBeNull()
    expect(first.result.current.cardProps.onParentWorktreeIdChange).toBeTypeOf('function')
    act(() => first.result.current.cardProps.onParentWorktreeIdChange('repo-1::/parent'))
    expect(first.result.current.cardProps.parentWorktreeId).toBe('repo-1::/parent')
    expect(first.result.current.cardProps.onNativeFileDrop).toBeUndefined()
    expect(second.result.current.cardProps.onNativeFileDrop).toBeUndefined()
    expect(window.api.ui.onFileDrop).not.toHaveBeenCalled()

    second.unmount()
    first.unmount()
    expect(window.api.ui.onFileDrop).not.toHaveBeenCalled()
  })
})
