// @vitest-environment happy-dom

// The resume tree as a control: tri-state at every level, exclusions, busy, and collapsing.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '../store'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  candidate,
  chatBox,
  countOf,
  disclosureOf,
  nodeBox,
  onToggleSpy,
  queryChatBox,
  seedTree,
  treeOutline,
  unretryable,
  worktree
} from './native-chat-resume-tree.test-support'
import { ResumeTreeHarness as Harness } from './NativeChatResumeTreeHarness.test-support'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement

function render(props: React.ComponentProps<typeof Harness>): void {
  act(() => root.render(<Harness {...props} />))
}

function state(box: HTMLElement): string | null {
  return box.getAttribute('aria-checked')
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
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('is tri-state at every level, each node over every chat under it', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  render({ candidates: seedTree({ parent: remote, child: remote }) })
  const machine = getHostContextLabel(remote)
  expect([machine, 'orca', 'parent', 'child', 'other'].map((name) => countOf(name))).toEqual([
    '4 of 4',
    '4 of 4',
    '3 of 3',
    '2 of 2',
    '1 of 1'
  ])

  act(() => chatBox('in-child').click())
  expect([machine, 'orca', 'parent', 'child', 'other'].map((name) => state(nodeBox(name)))).toEqual(
    ['mixed', 'mixed', 'mixed', 'mixed', 'true']
  )
  expect(countOf(machine)).toBe('3 of 4')
  expect(countOf('child')).toBe('1 of 2')

  // Partly selected: ticking selects everything under the node, nested workspaces included.
  act(() => nodeBox('parent').click())
  expect(state(chatBox('in-child'))).toBe('true')
  expect(state(nodeBox(machine))).toBe('true')

  act(() => nodeBox(machine).click())
  for (const id of ['in-parent', 'in-child', 'also-in-child', 'in-other']) {
    expect(state(chatBox(id))).toBe('false')
  }
  expect(countOf('orca')).toBe('0 of 4')
})

it('selects every eligible chat in a project, never an unretryable one or another project’s', () => {
  const candidates = seedTree()
  const mobile = worktree('mobile', { repoId: 'repo-2', id: 'repo-2::/mobile/mobile' })
  useAppStore.setState((current) => ({
    repos: [
      ...current.repos,
      { id: 'repo-2', path: '/mobile', displayName: 'orca-mobile', badgeColor: '#999', addedAt: 1 }
    ],
    worktreesByRepo: { ...current.worktreesByRepo, 'repo-2': [mobile] }
  }))
  const stuck = unretryable(candidates[3]!)
  render({
    candidates: [...candidates, candidate('in-mobile', mobile)],
    initiallySelected: ['in-mobile'],
    failureFor: (sessionId) => (sessionId === 'in-other' ? stuck : undefined)
  })
  expect(countOf('orca')).toBe('0 of 3')
  expect(chatBox('in-other').hasAttribute('disabled')).toBe(true)

  act(() => nodeBox('orca').click())
  expect(countOf('orca')).toBe('3 of 3')
  expect(state(nodeBox('orca'))).toBe('true')
  const touched = onToggleSpy.mock.calls.map(([sessionId]) => sessionId)
  expect(touched).not.toContain('in-other')
  expect(touched).not.toContain('in-mobile')
  expect(countOf('orca-mobile')).toBe('1 of 1')
})

it('disables a node with nothing it could select', () => {
  const candidates = seedTree()
  render({
    candidates,
    initiallySelected: [],
    failureFor: (sessionId) => (sessionId === 'in-other' ? unretryable(candidates[3]!) : undefined)
  })

  expect(nodeBox('other').hasAttribute('disabled')).toBe(true)
  expect(countOf('other')).toBeUndefined()
})

it('disables every checkbox while a resume runs', () => {
  render({ candidates: seedTree(), busy: true })

  const boxes = [...container.querySelectorAll('[role="checkbox"]')]
  expect(boxes).toHaveLength(8)
  for (const box of boxes) {
    expect(box.hasAttribute('disabled')).toBe(true)
  }
})

it('selects a whole row by clicking anywhere on it, but its arrow only folds', () => {
  render({ candidates: seedTree(), initiallySelected: [] })

  act(() => itemLabelBody('child').click())
  expect(state(chatBox('in-child'))).toBe('true')

  act(() => disclosureOf('other').click())
  expect(state(nodeBox('other'))).toBe('false')
  expect(queryChatBox('in-other')).toBeNull()
})

function itemLabelBody(name: string): HTMLElement {
  return nodeBox(name).closest('label')!.querySelector<HTMLElement>(':scope > :last-child')!
}

it('starts expanded; collapsing hides a node’s rows and keeps their selection', () => {
  render({ candidates: seedTree() })
  const parent = disclosureOf('parent')
  expect(parent.getAttribute('aria-expanded')).toBe('true')
  expect(parent.getAttribute('aria-label')).toBe('Collapse parent')
  expect(parent.tabIndex).toBe(-1)
  act(() => chatBox('in-child').click())

  act(() => parent.click())
  expect(treeOutline()).toEqual([
    '1:project:orca',
    '2:workspace:parent',
    '2:workspace:other',
    '3:chat:in-other'
  ])
  expect(disclosureOf('parent').getAttribute('aria-label')).toBe('Expand parent')
  expect(nodeBox('parent').closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe(
    'false'
  )
  // Hidden, not forgotten: the node still counts the pick made inside it.
  expect(state(nodeBox('parent'))).toBe('mixed')
  expect(countOf('parent')).toBe('2 of 3')

  act(() => disclosureOf('parent').click())
  expect(state(chatBox('in-child'))).toBe('false')
  expect(state(chatBox('also-in-child'))).toBe('true')
})

it('toggles the chats of a collapsed node', () => {
  render({ candidates: seedTree(), initiallySelected: [] })

  act(() => disclosureOf('parent').click())
  act(() => nodeBox('parent').click())
  expect(countOf('parent')).toBe('3 of 3')
  expect(onToggleSpy.mock.calls.map(([sessionId]) => sessionId).toSorted()).toEqual([
    'also-in-child',
    'in-child',
    'in-parent'
  ])
})
