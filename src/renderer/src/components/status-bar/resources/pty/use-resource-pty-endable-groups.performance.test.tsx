// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ResourcePtyGroup, ResourcePtyRow } from './resource-pty-view-model'
import { ResourcePtyActionStatus } from './resource-pty-action-status'
import {
  useResourcePtyEndableGroups,
  useResourcePtyGroupCanEnd
} from './use-resource-pty-endable-groups'

afterEach(cleanup)

it.each([300, 3_000])('updates a group with %i PTYs without revisiting its rows', (count) => {
  let eligibilityReads = 0
  const rows: ResourcePtyRow[] = Array.from({ length: count }, (_, index) => ({
    identity: `pty-${index}`,
    session: {
      id: `pty-${index}`,
      incarnationId: `incarnation-${index}`,
      title: 'Terminal',
      cwd: '',
      agentOwnership: 'absent',
      get fencedTermination() {
        eligibilityReads += 1
        return true
      }
    },
    label: 'Terminal',
    usesRuntimeTitle: false,
    sortName: 'Terminal',
    lastActivityAt: 0,
    workspace: 'Workspace',
    workspaceId: 'workspace',
    workspacePath: '/workspace',
    project: null,
    tabId: null,
    paneKey: null,
    binding: 'bound'
  }))
  const groups: ResourcePtyGroup[] = [{ kind: 'workspace', key: 'workspace', name: null, rows }]
  const ending = new ResourcePtyActionStatus()
  const selectionUpdate = vi.fn()
  const stopSelectionUpdates = ending.subscribeSelection(selectionUpdate)
  const { result, rerender } = renderHook(() => {
    const endability = useResourcePtyEndableGroups(groups, ending)
    return useResourcePtyGroupCanEnd(endability, 'workspace')
  })
  expect(result.current).toBe(true)
  expect(eligibilityReads).toBe(count)
  eligibilityReads = 0
  const identities = rows.map(({ identity }) => identity)
  act(() => {
    ending.start(identities)
  })
  expect(result.current).toBe(false)
  rerender()
  act(() => {
    ending.complete([{ identity: 'pty-0', error: 'agent_running' }], () => true)
  })
  expect(result.current).toBe(true)
  expect(eligibilityReads).toBe(0)
  expect(selectionUpdate).toHaveBeenCalledTimes(1)
  stopSelectionUpdates()
})
