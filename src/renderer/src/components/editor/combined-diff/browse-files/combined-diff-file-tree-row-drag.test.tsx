// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

const testState: { executionHostId: ExecutionHostId } = vi.hoisted(() => ({
  executionHostId: 'local'
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => testState.executionHostId
}))

const { CombinedDiffFileTreeRow } = await import('./combined-diff-file-tree-row')
const { readWorkspaceFileDragSource } = await import('@/lib/workspace-file-drag')

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  testState.executionHostId = 'local'
})

function renderRow(sourceWorkspaceId?: string): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <CombinedDiffFileTreeRow
        node={{
          type: 'directory',
          key: 'dir::unstaged::src',
          path: 'src',
          name: 'src',
          depth: 0,
          area: 'unstaged',
          fileCount: 1,
          children: []
        }}
        mode="uncommitted"
        worktreePath="/repo/worktree"
        sourceWorkspaceId={sourceWorkspaceId}
        activeSectionKey={null}
        sectionIndexByKey={new Map()}
        isCollapsed={false}
        onToggleDirectory={() => {}}
        onNavigate={() => {}}
      />
    )
  })
  return container
}

function dragRow(container: HTMLDivElement): DataTransfer {
  const transfer = new DataTransfer()
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  act(() => {
    container.querySelector('[draggable="true"]')?.dispatchEvent(event)
  })
  return transfer
}

describe('combined diff rows stamp their drag source', () => {
  // The tab's entry list is a snapshot, but the paths it drags belong to the
  // workspace as it is owned now — the same answer the source-control rows give.
  it('stamps the live owner of the workspace the diff belongs to', () => {
    testState.executionHostId = 'runtime:env-1'
    expect(readWorkspaceFileDragSource(dragRow(renderRow('wt-1')))).toEqual({
      executionHostId: 'runtime:env-1',
      workspaceId: 'wt-1'
    })
  })

  it('leaves the drag unstamped when the owner or the workspace is unknown', () => {
    expect(readWorkspaceFileDragSource(dragRow(renderRow(undefined)))).toBeNull()
    testState.executionHostId = 'runtime:unresolved-owner'
    expect(readWorkspaceFileDragSource(dragRow(renderRow('wt-1')))).toBeNull()
  })
})
