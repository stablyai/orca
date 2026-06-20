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

type LocalStartStepDomOptions = {
  isAdding?: boolean
  addProjectBusyLabel?: string | null
  nestedScanInProgress?: boolean
  nestedScanId?: string | null
}

async function renderLocalStartStepDom(
  isSshLikely: boolean,
  options: LocalStartStepDomOptions = {}
): Promise<{
  container: HTMLDivElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(
      <TooltipProvider>
        <AddRepoLocalStartStep
          repoCount={1}
          isSshLikely={isSshLikely}
          isAdding={options.isAdding ?? false}
          addProjectBusyLabel={options.addProjectBusyLabel ?? null}
          nestedScanInProgress={options.nestedScanInProgress ?? false}
          nestedScanId={options.nestedScanId ?? null}
          onBrowse={vi.fn()}
          onOpenCloneStep={vi.fn()}
          onOpenRemoteStep={vi.fn()}
          onOpenCreateStep={vi.fn()}
          onStopNestedScan={vi.fn()}
        />
      </TooltipProvider>
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

function getHostAwareActionModel(): {
  secondary: string[]
  createDisabled: boolean | undefined
} {
  const { secondaryActions } = getAddRepoLocalStartActions({
    isSshLikely: true,
    showRemoteAction: false,
    onBrowse: vi.fn(),
    onOpenCloneStep: vi.fn(),
    onOpenRemoteStep: vi.fn(),
    onOpenCreateStep: vi.fn()
  })
  const createAction = secondaryActions.find((action) => action.kind === 'create')

  return {
    secondary: secondaryActions.map((action) => action.title),
    createDisabled: createAction?.disabled
  }
}

function getRuntimeHostActionModel(): {
  primary: string
  description: string
} {
  const { primaryAction } = getAddRepoLocalStartActions({
    isSshLikely: false,
    showRemoteAction: false,
    browseHostKind: 'runtime',
    onBrowse: vi.fn(),
    onOpenCloneStep: vi.fn(),
    onOpenRemoteStep: vi.fn(),
    onOpenCreateStep: vi.fn()
  })

  return {
    primary: primaryAction.title,
    description: primaryAction.description
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
    expect(markup).toContain('Project on SSH host')
    expect(markup).toContain('Create new project')
    expect(markup).toContain('Other ways to add')
    expect(markup).not.toContain('More options')
  })

  it('orders secondary actions clone-first for default users', () => {
    const titles = getActionTitles(false)

    expect(titles.primary).toBe('Browse folder')
    expect(titles.secondary).toEqual([
      'Clone from URL',
      'Project on SSH host',
      'Create new project'
    ])
  })

  it('keeps Browse folder primary for SSH-likely users', () => {
    const markup = renderLocalStartStep(true)

    expect(markup).toContain('Browse folder')
    expect(markup).toContain('Project on SSH host')
    expect(markup).toContain('Clone from URL')
    expect(markup).toContain('Create new project')
  })

  it('orders secondary actions remote-first for SSH-likely users', () => {
    const titles = getActionTitles(true)

    expect(titles.primary).toBe('Browse folder')
    expect(titles.secondary).toEqual([
      'Project on SSH host',
      'Clone from URL',
      'Create new project'
    ])
  })

  it('lets host-aware Add Project replace the separate remote row', () => {
    const model = getHostAwareActionModel()

    expect(model.secondary).toEqual(['Clone from URL', 'Create new project'])
    expect(model.createDisabled).toBe(false)
  })

  it('uses host-neutral browse copy for runtime hosts', () => {
    const model = getRuntimeHostActionModel()

    expect(model.primary).toBe('Browse folder')
    expect(model.description).toBe('Existing Git repository or folder on this host')
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
    const remoteButton = findButton(container, 'Project on SSH host')

    expect(document.activeElement).toBe(browseButton)
    expect(document.activeElement).not.toBe(remoteButton)

    await act(async () => {
      root.unmount()
    })
  })

  it('renders secondary actions as enabled buttons without a disclosure toggle', async () => {
    const { container, root } = await renderLocalStartStepDom(false)

    expect(findButton(container, 'Clone from URL').disabled).toBe(false)
    expect(findButton(container, 'Project on SSH host').disabled).toBe(false)
    expect(findButton(container, 'Create new project').disabled).toBe(false)

    await act(async () => {
      root.unmount()
    })
  })

  it('marks the autofocused Browse action as selected with the ⏎ chip', async () => {
    const { container, root } = await renderLocalStartStepDom(false)

    expect(findButton(container, 'Browse folder').textContent).toContain('⏎')
    expect(findButton(container, 'Clone from URL').textContent).not.toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })

  it('moves the ⏎ selection to whichever action receives focus', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const cloneButton = findButton(container, 'Clone from URL')

    await act(async () => {
      cloneButton.focus()
    })

    expect(findButton(container, 'Clone from URL').textContent).toContain('⏎')
    expect(findButton(container, 'Browse folder').textContent).not.toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })

  it('clears the ⏎ selection when focus leaves the action list', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const outsideButton = document.createElement('button')
    document.body.appendChild(outsideButton)

    await act(async () => {
      outsideButton.focus()
    })

    expect(document.activeElement).toBe(outsideButton)
    expect(findButton(container, 'Browse folder').textContent).not.toContain('⏎')
    expect(findButton(container, 'Clone from URL').textContent).not.toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })

  it('does not show an ⏎ selection while add actions are busy', async () => {
    const { container, root } = await renderLocalStartStepDom(false, {
      isAdding: true,
      addProjectBusyLabel: 'Scanning repositories',
      nestedScanInProgress: true,
      nestedScanId: 'scan-1'
    })
    const stopScanButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop scan"]'
    )

    await act(async () => {
      stopScanButton?.focus()
    })

    expect(document.activeElement).toBe(stopScanButton)
    expect(findButton(container, 'Browse folder').textContent).not.toContain('⏎')
    expect(findButton(container, 'Clone from URL').textContent).not.toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })

  it('hides the visual ⏎ chip from assistive technology', async () => {
    const { container, root } = await renderLocalStartStepDom(false)
    const browseButton = findButton(container, 'Browse folder')
    const enterChip = Array.from(browseButton.querySelectorAll('[aria-hidden="true"]')).find(
      (entry) => entry.textContent?.includes('⏎')
    )

    expect(enterChip).toBeTruthy()

    await act(async () => {
      root.unmount()
    })
  })

  it('roves selection down the action list with the ArrowDown key', async () => {
    const { container, root } = await renderLocalStartStepDom(false)

    await act(async () => {
      findButton(container, 'Browse folder').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    })

    // ArrowDown from Browse moves focus — and the ⏎ chip — to the first secondary action.
    const firstSecondary = findButton(container, 'Clone from URL')
    expect(document.activeElement).toBe(firstSecondary)
    expect(firstSecondary.textContent).toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })
})

describe('AddRepoServerPathStartStep', () => {
  it('uses native-style project entry cards in server mode', () => {
    const markup = renderServerPathStartStep('env-1')

    expect(markup).toContain('Add a project')
    expect(markup).toContain('Add another project from the selected host.')
    expect(markup).toContain('Browse host')
    expect(markup).toContain('Clone from URL')
    expect(markup).toContain('Create on host')
    expect(markup).toContain('Want to import many repos at once?')
    expect(markup).toContain('Or enter a host path manually')
  })

  it('disables server entry cards without an active runtime environment', () => {
    const markup = renderServerPathStartStep(null)

    expect(markup).toContain('disabled=""')
  })
})
