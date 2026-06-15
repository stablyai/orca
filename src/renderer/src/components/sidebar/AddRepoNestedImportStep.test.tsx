// @vitest-environment happy-dom

import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddRepoNestedImportStep } from './AddRepoNestedImportStep'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog } from '@/components/ui/dialog'
import type { NestedRepoScanResult } from '../../../../shared/types'

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

function renderStepMarkup(
  overrides: Partial<ComponentProps<typeof AddRepoNestedImportStep>> = {}
): string {
  return renderToStaticMarkup(
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
          onImport={vi.fn()}
          onStopScan={vi.fn()}
          {...overrides}
        />
      </Dialog>
    </TooltipProvider>
  )
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

  it('asks whether the selected folder is a monorepo', () => {
    const html = renderStepMarkup()

    expect(html).toContain('Import repositories from folder')
    expect(html).toContain('Found 3 repositories in')
    expect(html).toContain('/workspace/platform')
    expect(html).toContain('aria-label="Monorepo name"')
    expect(html).not.toContain('What is a')
    expect(html).toContain('Is this a monorepo?')
    expect(html).toContain('Choose this if these projects belong together')
    expect(html).toContain('Orca will group them and let you work from the parent folder')
    expect(html).toContain('No, import separately')
    expect(html).toContain('Yes, import as monorepo')
    expect(html).toContain('payments/api')
    expect(html).toContain('billing/api')
    expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('>Back</button>')
    expect(html).not.toContain('Project group')
  })

  it('disables both import actions while scanning', () => {
    const html = renderStepMarkup({ scanInProgress: true })

    expect(html).toContain('Is this a monorepo?')
    expect(html).toContain('No, import separately')
    expect(html).toContain('Yes, import as monorepo')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>No, import separately<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Yes, import as monorepo<\/button>/)
  })

  it('maps the monorepo choice to grouped import and the non-monorepo choice to separate import', () => {
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
              onStopScan={vi.fn()}
            />
          </Dialog>
        </TooltipProvider>
      )
    })

    act(() => {
      findButton(host, 'Yes, import as monorepo').click()
      findButton(host, 'No, import separately').click()
    })

    expect(onImport).toHaveBeenNthCalledWith(1, 'group')
    expect(onImport).toHaveBeenNthCalledWith(2, 'separate')
  })

  it('shows progress only on the clicked import action', () => {
    const onImport = vi.fn()
    const host = document.createElement('div')
    container = host
    document.body.appendChild(host)
    root = createRoot(host)

    function Harness(): React.JSX.Element {
      const [isAdding, setIsAdding] = useState(false)
      return (
        <TooltipProvider>
          <Dialog open>
            <AddRepoNestedImportStep
              scan={scan}
              groupName=""
              selectedPaths={new Set(scan.repos.map((repo) => repo.path))}
              isAdding={isAdding}
              scanInProgress={false}
              onGroupNameChange={vi.fn()}
              onSelectedPathsChange={vi.fn()}
              onImport={(mode) => {
                onImport(mode)
                setIsAdding(true)
              }}
              onStopScan={vi.fn()}
            />
          </Dialog>
        </TooltipProvider>
      )
    }

    act(() => {
      root?.render(<Harness />)
    })

    act(() => {
      findButton(host, 'Yes, import as monorepo').click()
    })

    expect(onImport).toHaveBeenCalledWith('group')
    expect(
      findButton(host, 'Yes, import as monorepo').querySelector('.animate-spin')
    ).not.toBeNull()
    expect(findButton(host, 'No, import separately').querySelector('.animate-spin')).toBeNull()
  })
})
