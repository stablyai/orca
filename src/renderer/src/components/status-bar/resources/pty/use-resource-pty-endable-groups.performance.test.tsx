// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ResourcePtyGroup, ResourcePtyRow } from './resource-pty-view-model'
import type { ResourcePtyEndingSource } from './use-resource-pty-actions'
import { useResourcePtyEndableGroups } from './use-resource-pty-endable-groups'

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
    project: null,
    tabId: null,
    paneKey: null,
    binding: 'bound'
  }))
  const groups: ResourcePtyGroup[] = [{ kind: 'workspace', key: 'workspace', name: null, rows }]
  const keys = new Set<string>()
  const listeners = new Set<Parameters<ResourcePtyEndingSource['subscribe']>[0]>()
  const ending: ResourcePtyEndingSource = {
    getKeys: () => keys,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const { result, rerender } = renderHook(() => useResourcePtyEndableGroups(groups, ending))
  expect(result.current.has('workspace')).toBe(true)
  expect(eligibilityReads).toBe(count)
  eligibilityReads = 0
  const identities = rows.map(({ identity }) => identity)
  act(() => {
    for (const identity of identities) {
      keys.add(identity)
    }
    for (const listener of listeners) {
      listener(identities, true)
    }
  })
  expect(result.current.has('workspace')).toBe(false)
  rerender()
  act(() => {
    keys.delete('pty-0')
    for (const listener of listeners) {
      listener(['pty-0'], false)
    }
  })
  expect(result.current.has('workspace')).toBe(true)
  expect(eligibilityReads).toBe(0)
})
