// @vitest-environment happy-dom

import { act } from 'react'

import { createRoot, type Root } from 'react-dom/client'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddRepoNestedImportStep } from './AddRepoNestedImportStep'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog } from '@/components/ui/dialog'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'

const scan: NestedRepoScanResult = {
  selectedPath: '/workspace/platform',
  selectedPathKind: 'non_git_folder',
  repos: [
    { path: '/workspace/platform/web', displayName: 'web', depth: 1 },
    { path: '/workspace/platform/payments/api', displayName: 'api', depth: 2 },
    { path: '/workspace/platform/billing/api', displayName: 'api', depth: 2 }
  ],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 4,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
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

describe('AddRepoNestedImportStep', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    container?.remove()
    container = null
  })

  it('maps the group choice to grouped import and the separate choice to separate import', () => {
    const onImport = vi.fn()
    const host = document.createElement('div')
    container = host
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        <TooltipProvider>
          <Dialog open>
            <AddRepoNestedImportStep
              scan={scan}
              groupName=""
              selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
              isAdding={false}
              scanInProgress={false}
              onGroupNameChange={vi.fn()}
              onSelectedPathsChange={vi.fn()}
              onImport={onImport}
              onOpenAsFolder={vi.fn()}
              onStopScan={vi.fn()}
            />
          </Dialog>
        </TooltipProvider>
      )
    })

    act(() => {
      findButton(host, 'Yes, import as group').click()
      findButton(host, 'No, import separately').click()
    })

    expect(onImport).toHaveBeenNthCalledWith(1, 'group')
    expect(onImport).toHaveBeenNthCalledWith(2, 'separate')
  })

  it('offers opening the parent folder when no repositories are selected', () => {
    const onOpenAsFolder = vi.fn()
    const host = document.createElement('div')
    container = host
    document.body.appendChild(host)
    root = createRoot(host)

    act(() => {
      root?.render(
        <TooltipProvider>
          <Dialog open>
            <AddRepoNestedImportStep
              scan={scan}
              groupName=""
              selectedPaths={new Set()}
              isAdding={false}
              scanInProgress={false}
              onGroupNameChange={vi.fn()}
              onSelectedPathsChange={vi.fn()}
              onImport={vi.fn()}
              onOpenAsFolder={onOpenAsFolder}
              onStopScan={vi.fn()}
            />
          </Dialog>
        </TooltipProvider>
      )
    })

    expect(host.textContent).toContain('No repositories are selected')
    expect(findButton(host, 'No, import separately').disabled).toBe(true)
    expect(findButton(host, 'Yes, import as group').disabled).toBe(true)
    expect(findButton(host, 'Open as Folder').disabled).toBe(false)

    act(() => {
      findButton(host, 'Open as Folder').click()
    })

    expect(onOpenAsFolder).toHaveBeenCalledTimes(1)
  })
})
