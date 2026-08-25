// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../shared/linear/project-types'
import {
  LinearCollectionNotice,
  LinearCustomViewTable,
  LinearProjectOverview,
  LinearProjectTable
} from './linear-project-view-surfaces'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: Root[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.replaceChildren()
})

function render(element: React.ReactNode): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => root.render(<TooltipProvider>{element}</TooltipProvider>))
  return container
}

const project: LinearProjectSummary = {
  id: 'project-1',
  workspaceId: 'workspace-1',
  workspaceName: 'Acme',
  name: 'Compiler',
  url: 'https://linear.app/project/project-1',
  labels: [
    { id: 'label-1', name: 'Alpha' },
    { id: 'label-2', name: 'Beta' },
    { id: 'label-3', name: 'Hidden' }
  ],
  progress: 0.5,
  priority: 2,
  targetDate: 'invalid-date'
}

describe('Linear project view surfaces', () => {
  it('renders collection errors and controlled pagination without changing ownership', () => {
    const onLoadMore = vi.fn()
    const container = render(
      <LinearCollectionNotice
        errors={[
          {
            workspaceId: 'workspace-1',
            workspaceName: 'Acme',
            type: 'auth',
            message: 'Reconnect Linear'
          }
        ]}
        hasMore
        count={50}
        label="projects"
        onLoadMore={onLoadMore}
      />
    )
    expect(container.textContent).toContain('Acme: Reconnect Linear')
    const button = container.querySelector('button')
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onLoadMore).toHaveBeenCalledOnce()
  })

  it('keeps project row keyboard selection and nested actions independent', () => {
    const onSelectProject = vi.fn()
    const onOpenProject = vi.fn()
    const onUseProjectIssues = vi.fn()
    const container = render(
      <LinearProjectTable
        projects={[project]}
        loading={false}
        selectedProjectId="project-1"
        workspaceSelection="all"
        onSelectProject={onSelectProject}
        onOpenProject={onOpenProject}
        onUseProjectIssues={onUseProjectIssues}
      />
    )
    const row = container.querySelector('[role="button"]') as HTMLElement
    expect(row.getAttribute('aria-current')).toBe('true')
    expect(row.dataset.current).toBe('true')
    expect(container.textContent).toContain('Acme')
    expect(container.textContent).toContain('Alpha')
    expect(container.textContent).toContain('Beta')
    expect(container.textContent).not.toContain('Hidden')
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSelectProject).toHaveBeenCalledWith(project)

    const issuesButton = container.querySelector('button[aria-label="Open Compiler issues"]')
    act(() => issuesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onUseProjectIssues).toHaveBeenCalledWith(project)
    expect(onSelectProject).toHaveBeenCalledTimes(1)

    const openButton = container.querySelectorAll('button[aria-label="Open Compiler issues"]')[1]
    act(() => openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onOpenProject).toHaveBeenCalledWith(project)
    expect(onSelectProject).toHaveBeenCalledTimes(1)
  })

  it('preserves custom-view metadata and overview action callbacks', () => {
    const view: LinearCustomViewSummary = {
      id: 'view-1',
      name: 'Triage',
      model: 'issue',
      shared: true,
      owner: { id: 'user-1', displayName: 'Ada' }
    }
    const onSelectView = vi.fn()
    const onOpenView = vi.fn()
    const views = render(
      <LinearCustomViewTable
        views={[view]}
        loading={false}
        onSelectView={onSelectView}
        onOpenView={onOpenView}
      />
    )
    expect(views.textContent).toContain('Shared')
    expect(views.textContent).toContain('Ada')
    const row = views.querySelector('[role="button"]') as HTMLElement
    act(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })))
    expect(onSelectView).toHaveBeenCalledWith(view)

    const onBack = vi.fn()
    const onRefresh = vi.fn()
    const onOpenIssues = vi.fn()
    const onOpenProject = vi.fn()
    const overview = render(
      <LinearProjectOverview
        project={project}
        loading={false}
        onBack={onBack}
        onRefresh={onRefresh}
        onOpenIssues={onOpenIssues}
        onOpenProject={onOpenProject}
      />
    )
    expect(overview.textContent).toContain('Compiler')
    act(() =>
      overview
        .querySelector('button[aria-label="Back to projects"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    expect(onBack).toHaveBeenCalledOnce()
    const refresh = [...overview.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Refresh')
    )
    act(() => refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
})
