// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import * as decisions from './composer-decisions'
import { useComposerTargetStore } from './composer-target-store'
import { useComposerInitialTargetState } from './initial-target-state'

beforeEach(() => {
  useAppStore.setState({
    workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
    hostWorkspaceStatuses: { 'env-1': [{ id: 'status-6', label: 'Today' }] },
    removedRuntimeEnvironmentIds: new Set()
  })
})

afterEach(cleanup)

describe('composer initial workspace status', () => {
  it("keeps a paired host's own column from that host's board lane", () => {
    const { result } = renderHook(() =>
      useComposerInitialTargetState(
        useComposerTargetStore(
          { persistDraft: false, initialWorkspaceStatus: 'status-6' },
          decisions
        )
      )
    )

    expect(result.current.resolvedInitialWorkspaceStatus).toBe('status-6')
  })
})
