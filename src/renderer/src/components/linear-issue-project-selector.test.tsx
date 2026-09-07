// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { LinearProjectSummary } from '../../../shared/linear/project-types'
import { normalizeTaskSourceContext } from '../../../shared/task-source-context'
import { LinearIssueProjectSelector } from './linear-issue-project-selector'

const runtimeMocks = vi.hoisted(() => ({
  linearListProjects: vi.fn(),
  linearUpdateIssue: vi.fn()
}))
const storeMocks = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: null },
    patchLinearIssue: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-linear-project-client', () => ({
  linearListProjects: runtimeMocks.linearListProjects
}))
vi.mock('@/runtime/runtime-linear-issue-mutations', () => ({
  linearUpdateIssue: runtimeMocks.linearUpdateIssue
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMocks.state) => unknown) => selector(storeMocks.state)
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const selectedIssue: LinearIssue = {
  id: 'issue-1',
  workspaceId: 'workspace-1',
  identifier: 'ENG-1',
  title: 'Fix compiler',
  url: 'https://linear.app/issue/ENG-1',
  state: { name: 'Todo', type: 'unstarted', color: '#999999' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 2,
  updatedAt: '2026-08-01T00:00:00.000Z'
}
const sourceContext = normalizeTaskSourceContext({
  provider: 'linear',
  hostId: 'runtime:environment-1',
  projectId: 'project-group-1'
})!
const roots: Root[] = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('LinearIssueProjectSelector', () => {
  it('ignores stale searches and preserves exact source-scoped assignment calls', async () => {
    const first = deferred<{ items: LinearProjectSummary[] }>()
    const second = deferred<{ items: LinearProjectSummary[] }>()
    runtimeMocks.linearListProjects
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    runtimeMocks.linearUpdateIssue.mockResolvedValue({ ok: true })
    const onProjectChanged = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => {
      root.render(
        <LinearIssueProjectSelector
          issue={selectedIssue}
          onProjectChanged={onProjectChanged}
          sourceContext={sourceContext}
        />
      )
    })
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const input = document.body.querySelector('input') as HTMLInputElement
    act(() => setInputValue(input, 'first'))
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(runtimeMocks.linearListProjects).toHaveBeenLastCalledWith(
      sourceContext,
      'first',
      20,
      'workspace-1'
    )

    act(() => setInputValue(input, 'second'))
    await act(async () => vi.advanceTimersByTimeAsync(150))
    expect(runtimeMocks.linearListProjects).toHaveBeenLastCalledWith(
      sourceContext,
      'second',
      20,
      'workspace-1'
    )
    const currentProject = { id: 'project-2', name: 'Second project' }
    await act(async () => {
      second.resolve({ items: [currentProject] })
      await Promise.resolve()
    })
    await act(async () => {
      first.resolve({ items: [{ id: 'project-1', name: 'Stale project' }] })
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain('Second project')
    expect(document.body.textContent).not.toContain('Stale project')

    const projectButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Second project')
    )
    await act(async () => {
      projectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(runtimeMocks.linearUpdateIssue).toHaveBeenCalledWith(
      sourceContext,
      'issue-1',
      { projectId: 'project-2' },
      'workspace-1'
    )
    expect(storeMocks.state.patchLinearIssue).toHaveBeenCalledWith(
      'issue-1',
      { project: currentProject },
      { sourceContext }
    )
    expect(onProjectChanged).toHaveBeenCalledWith(currentProject)
  })
})
