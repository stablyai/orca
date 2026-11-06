// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'

vi.mock('@/components/ui/dialog', () => ({
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

type LocalStartStepDomOptions = {
  isAdding?: boolean
  actionsDisabled?: boolean
  addProjectBusyLabel?: string | null
  nestedScanInProgress?: boolean
  nestedScanId?: string | null
}

async function renderLocalStartStepDom(options: LocalStartStepDomOptions = {}): Promise<{
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
          isAdding={options.isAdding ?? false}
          actionsDisabled={options.actionsDisabled ?? false}
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

describe('AddRepoLocalStartStep', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('roves selection down the action list with the ArrowDown key', async () => {
    const { container, root } = await renderLocalStartStepDom()

    await act(async () => {
      findButton(container, 'Browse folder').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    })

    const firstSecondary = findButton(container, 'Clone from URL')
    expect(document.activeElement).toBe(firstSecondary)
    expect(firstSecondary.textContent).toContain('⏎')

    await act(async () => {
      root.unmount()
    })
  })
})
