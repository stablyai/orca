// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'
import { getAddRepoLocalStartActions } from './add-repo-local-start-actions'

vi.mock('@/components/ui/dialog', () => ({
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

function renderLocalStartStep(isSshLikely: boolean): string {
  return renderToStaticMarkup(
    <AddRepoLocalStartStep
      repoCount={1}
      isSshLikely={isSshLikely}
      isAdding={false}
      addProjectBusyLabel={null}
      nestedScanInProgress={false}
      nestedScanId={null}
      onBrowse={vi.fn()}
      onOpenCloneStep={vi.fn()}
      onOpenRemoteStep={vi.fn()}
      onOpenCreateStep={vi.fn()}
      onStopNestedScan={vi.fn()}
    />
  )
}

async function renderLocalStartStepDom(isSshLikely: boolean): Promise<{
  container: HTMLDivElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      <AddRepoLocalStartStep
        repoCount={1}
        isSshLikely={isSshLikely}
        isAdding={false}
        addProjectBusyLabel={null}
        nestedScanInProgress={false}
        nestedScanId={null}
        onBrowse={vi.fn()}
        onOpenCloneStep={vi.fn()}
        onOpenRemoteStep={vi.fn()}
        onOpenCreateStep={vi.fn()}
        onStopNestedScan={vi.fn()}
      />
    )
  })

  return { container, root }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label)
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getActionTitles(isSshLikely: boolean): {
  primary: string
  secondary: string | null
  moreOptions: string[]
} {
  const { primaryAction, secondaryAction, moreOptions } = getAddRepoLocalStartActions({
    isSshLikely,
    onBrowse: vi.fn(),
    onOpenCloneStep: vi.fn(),
    onOpenRemoteStep: vi.fn(),
    onOpenCreateStep: vi.fn()
  })

  return {
    primary: primaryAction.title,
    secondary: secondaryAction?.title ?? null,
    moreOptions: moreOptions.map((action) => action.title)
  }
}

describe('AddRepoLocalStartStep', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('promotes browse folder and hides uncommon actions by default', () => {
    const markup = renderLocalStartStep(false)

    expect(markup).toContain('Browse folder')
    expect(markup).toContain('More options')
    expect(markup).toContain('aria-expanded="false"')
    expect(markup).not.toContain('Clone from URL')
    expect(markup).not.toContain('Remote project')
    expect(markup).not.toContain('Create new project')
  })

  it('keeps clone, remote, and create actions in More options for default users', () => {
    const titles = getActionTitles(false)

    expect(titles.primary).toBe('Browse folder')
    expect(titles.secondary).toBeNull()
    expect(titles.moreOptions).toEqual(['Clone from URL', 'Remote project', 'Create new project'])
  })

  it('promotes remote project first for SSH-likely users', () => {
    const markup = renderLocalStartStep(true)

    const remoteIndex = markup.indexOf('Remote project')
    const browseIndex = markup.indexOf('Browse folder')

    expect(remoteIndex).toBeGreaterThanOrEqual(0)
    expect(browseIndex).toBeGreaterThanOrEqual(0)
    expect(remoteIndex).toBeLessThan(browseIndex)
    expect(markup).toContain('More options')
    expect(markup).not.toContain('Clone from URL')
    expect(markup).not.toContain('Create new project')
  })

  it('keeps clone and create in More options for SSH-likely users', () => {
    const titles = getActionTitles(true)

    expect(titles.primary).toBe('Remote project')
    expect(titles.secondary).toBe('Browse folder')
    expect(titles.moreOptions).toEqual(['Clone from URL', 'Create new project'])
  })

  it('focuses Browse folder when the default Add Project step opens', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const browseButton = findButton(container, 'Browse folder')

    expect(document.activeElement).toBe(browseButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('focuses Browse folder even when SSH-likely users see Remote project first', async () => {
    const { container, root } = await renderLocalStartStepDom(true)
    const browseButton = findButton(container, 'Browse folder')
    const remoteButton = findButton(container, 'Remote project')

    expect(document.activeElement).toBe(browseButton)
    expect(document.activeElement).not.toBe(remoteButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('uses the shared collapsible height animation for More options', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const toggle = findButton(container, 'More options')
    const controlledId = toggle.getAttribute('aria-controls')
    if (!controlledId) {
      throw new Error('More options control is missing aria-controls')
    }

    const closedPanel = document.getElementById(controlledId)
    expect(closedPanel).not.toBeNull()
    expect(closedPanel?.classList.contains('collapsible-height-content')).toBe(true)
    expect(closedPanel?.getAttribute('data-state')).toBe('closed')
    expect(closedPanel?.hasAttribute('hidden')).toBe(true)

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const openPanel = document.getElementById(controlledId)
    expect(openPanel).not.toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(openPanel?.classList.contains('collapsible-height-content')).toBe(true)
    expect(openPanel?.getAttribute('data-state')).toBe('open')
    expect(findButton(container, 'Clone from URL').disabled).toBe(false)

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      root.unmount()
    })
  })
})
