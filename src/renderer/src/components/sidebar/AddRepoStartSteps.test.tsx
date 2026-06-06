// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'
import { AddRepoServerPathStartStep } from './AddRepoServerStartStep'
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

function renderServerPathStartStep(runtimeEnvironmentId: string | null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AddRepoServerPathStartStep
        serverPath=""
        runtimeEnvironmentId={runtimeEnvironmentId}
        isAddingServerPath={false}
        addProjectBusyLabel={null}
        onServerPathChange={vi.fn()}
        onAddServerPath={vi.fn()}
        onOpenCloneStep={vi.fn()}
        onOpenCreateStep={vi.fn()}
      />
    </TooltipProvider>
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
  secondary: string[]
} {
  const { primaryAction, secondaryActions } = getAddRepoLocalStartActions({
    isSshLikely,
    onBrowse: vi.fn(),
    onOpenCloneStep: vi.fn(),
    onOpenRemoteStep: vi.fn(),
    onOpenCreateStep: vi.fn()
  })

  return {
    primary: primaryAction.title,
    secondary: secondaryActions.map((action) => action.title)
  }
}

describe('AddRepoLocalStartStep', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('promotes browse folder and keeps secondary actions always visible', () => {
    const markup = renderLocalStartStep(false)

    expect(markup).toContain('Browse folder')
    expect(markup).toContain('Clone from URL')
    expect(markup).toContain('Remote project')
    expect(markup).toContain('Create new project')
    expect(markup).toContain('Or add from')
    expect(markup).not.toContain('More options')
  })

  it('orders secondary actions clone-first for default users', () => {
    const titles = getActionTitles(false)

    expect(titles.primary).toBe('Browse folder')
    expect(titles.secondary).toEqual(['Clone from URL', 'Remote project', 'Create new project'])
  })

  it('keeps Browse folder primary for SSH-likely users', () => {
    const markup = renderLocalStartStep(true)

    expect(markup).toContain('Browse folder')
    expect(markup).toContain('Remote project')
    expect(markup).toContain('Clone from URL')
    expect(markup).toContain('Create new project')
  })

  it('orders secondary actions remote-first for SSH-likely users', () => {
    const titles = getActionTitles(true)

    expect(titles.primary).toBe('Browse folder')
    expect(titles.secondary).toEqual(['Remote project', 'Clone from URL', 'Create new project'])
  })

  it('focuses Browse folder when the default Add Project step opens', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const browseButton = findButton(container, 'Browse folder')

    expect(document.activeElement).toBe(browseButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('focuses Browse folder for SSH-likely users too', async () => {
    const { container, root } = await renderLocalStartStepDom(true)
    const browseButton = findButton(container, 'Browse folder')
    const remoteButton = findButton(container, 'Remote project')

    expect(document.activeElement).toBe(browseButton)
    expect(document.activeElement).not.toBe(remoteButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('renders secondary actions as enabled buttons without a disclosure toggle', async () => {
    const { container, root } = await renderLocalStartStepDom(false)

    expect(findButton(container, 'Clone from URL').disabled).toBe(false)
    expect(findButton(container, 'Remote project').disabled).toBe(false)
    expect(findButton(container, 'Create new project').disabled).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })
})

describe('AddRepoServerPathStartStep', () => {
  it('uses native-style project entry cards in server mode', () => {
    const markup = renderServerPathStartStep('env-1')

    expect(markup).toContain('Add a project')
    expect(markup).toContain('Add another project from the selected runtime server.')
    expect(markup).toContain('Browse server')
    expect(markup).toContain('Clone from URL')
    expect(markup).toContain('Create on server')
    expect(markup).toContain('Want to import many repos at once?')
    expect(markup).toContain('Or enter a server path manually')
  })

  it('disables server entry cards without an active runtime environment', () => {
    const markup = renderServerPathStartStep(null)

    expect(markup).toContain('disabled=""')
  })
})
