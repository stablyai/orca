// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  candidate,
  chatBox,
  lineage,
  onToggleSpy,
  seedTree,
  worktree
} from './native-chat-resume-tree.test-support'
import { ResumeTreeHarness as Harness } from './NativeChatResumeTreeHarness.test-support'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement

function render(props: React.ComponentProps<typeof Harness>): void {
  act(() => root.render(<Harness {...props} />))
}

beforeEach(() => {
  onToggleSpy.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('lists every offered chat exactly once, even with one workspace id on two hosts', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  const candidates = seedTree()
  const remoteParent = worktree('parent', { hostId: remote, instanceId: 'instance-remote' })
  useAppStore.setState((state) => ({
    worktreesByRepo: { 'repo-1': [...state.worktreesByRepo['repo-1']!, remoteParent] }
  }))
  const twin = candidate('on-remote', remoteParent)
  render({ candidates: [...candidates, twin] })

  for (const entry of [...candidates, twin]) {
    expect(
      container.querySelectorAll(`[role="checkbox"][aria-label*="Prompt ${entry.sessionId}"]`)
    ).toHaveLength(1)
  }
  // Same id, different machine: two separate workspace nodes.
  expect(container.querySelectorAll('[aria-label="Select all chats in parent"]')).toHaveLength(2)
})

it('lists every chat when workspace lineage loops', () => {
  const a = worktree('a')
  const b = worktree('b')
  useAppStore.setState({
    settings: getDefaultSettings(''),
    worktreesByRepo: { 'repo-1': [a, b] },
    worktreeLineageById: { [a.id]: lineage(a, b), [b.id]: lineage(b, a) }
  })
  render({ candidates: [candidate('in-a', a), candidate('in-b', b)] })

  expect(chatBox('in-a')).toBeTruthy()
  expect(chatBox('in-b')).toBeTruthy()
})
