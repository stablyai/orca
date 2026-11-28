// @vitest-environment happy-dom
// Guards the fix forward for PR #45956: each retained split layout ran its own store selector on every
// write, so an editor keystroke read every layout's groups. A write that touches no workspace's groups
// or tabs must read and re-render no retained layout, gate open or closed.
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { useReleasedLayoutInputs } from './released-layout-inputs'

const LAYOUTS = 750
const ids = Array.from({ length: LAYOUTS }, (_, i) => `repo::/wt-${i}`)
const renders = new Map<string, number>()
let groupReads = 0

function Surface({ id, gateOpen }: { id: string; gateOpen: boolean }): null {
  useReleasedLayoutInputs(id, gateOpen)
  renders.set(id, (renders.get(id) ?? 0) + 1)
  return null
}

function seedCountingGroupReads(): void {
  const groupsByWorktree: AppState['groupsByWorktree'] = {}
  for (const id of ids) {
    const groups = [{ id: `${id}-g`, worktreeId: id, activeTabId: null, tabOrder: [] }]
    Object.defineProperty(groupsByWorktree, id, {
      enumerable: true,
      get: () => {
        groupReads += 1
        return groups
      }
    })
  }
  useAppStore.setState({ groupsByWorktree })
}

afterEach(() => {
  cleanup()
  renders.clear()
  groupReads = 0
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('editor input reads and re-renders no retained layout; a groups write reaches only its workspace', () => {
  seedCountingGroupReads()
  render(
    <>
      {ids.map((id, i) => (
        <Surface key={id} id={id} gateOpen={i % 2 === 0} />
      ))}
    </>
  )
  renders.clear()
  groupReads = 0

  for (let key = 0; key < 10; key++) {
    act(() => useAppStore.setState({ editorDrafts: { 'file-1': `typed ${key}` } }))
  }
  expect(groupReads).toBe(0)
  expect(renders.size).toBe(0)

  const target = ids[0]
  act(() =>
    useAppStore.setState((state) => ({
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [target]: [{ id: 'g-new', worktreeId: target, activeTabId: null, tabOrder: [] }]
      }
    }))
  )
  expect([...renders.keys()]).toEqual([target])
})
