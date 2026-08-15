// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { RepositoryHostCloneStep } from './RepositoryHostCloneStep'

let container: HTMLDivElement
let root: Root
const pickDirectory = vi.fn()
const listRepositories = vi.fn()

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  pickDirectory.mockReset()
  listRepositories.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      repos: { pickDirectory },
      gh: { listRepositories }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderStep(
  overrides: { cloneUrl?: string; onCloneUrlChange?: (value: string) => void } = {}
): void {
  act(() => {
    root.render(
      <TooltipProvider>
        <RepositoryHostCloneStep
          hostId="local"
          cloneUrl={overrides.cloneUrl ?? ''}
          cloneDestination=""
          disabled={false}
          isCloning={false}
          onBack={vi.fn()}
          onCloneUrlChange={overrides.onCloneUrlChange ?? vi.fn()}
          onCloneDestinationChange={vi.fn()}
          onSubmit={vi.fn()}
        />
      </TooltipProvider>
    )
  })
}

describe('RepositoryHostCloneStep', () => {
  it('uses the native directory picker for the local host', async () => {
    const onCloneDestinationChange = vi.fn()
    pickDirectory.mockResolvedValue('/Users/alice/projects')
    act(() => {
      root.render(
        <TooltipProvider>
          <RepositoryHostCloneStep
            hostId="local"
            cloneUrl="https://github.com/acme/orca.git"
            cloneDestination=""
            disabled={false}
            isCloning={false}
            onBack={vi.fn()}
            onCloneUrlChange={vi.fn()}
            onCloneDestinationChange={onCloneDestinationChange}
            onSubmit={vi.fn()}
          />
        </TooltipProvider>
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Choose folder"]')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
      await Promise.resolve()
    })

    expect(pickDirectory).toHaveBeenCalledOnce()
    expect(onCloneDestinationChange).toHaveBeenCalledWith('/Users/alice/projects')
  })

  it('loads and selects repositories from the authenticated GitHub account', async () => {
    const onCloneUrlChange = vi.fn()
    listRepositories.mockResolvedValue([
      {
        nameWithOwner: 'acme/orca',
        description: 'Agent workspace',
        isPrivate: true,
        updatedAt: '2026-07-18T20:00:00Z',
        httpsUrl: 'https://github.com/acme/orca.git',
        sshUrl: 'git@github.com:acme/orca.git'
      }
    ])
    renderStep({ onCloneUrlChange })

    const trigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Choose from GitHub')
    )
    expect(trigger).toBeTruthy()
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const repository = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
      (item) => item.textContent?.includes('acme/orca')
    )
    expect(repository).toBeTruthy()
    expect(repository?.textContent).toContain('Private repository')
    act(() => repository?.click())

    expect(listRepositories).toHaveBeenCalledOnce()
    expect(onCloneUrlChange).toHaveBeenCalledWith('https://github.com/acme/orca.git')
  })

  it('preserves the current SSH clone protocol when selecting a repository', async () => {
    const onCloneUrlChange = vi.fn()
    listRepositories.mockResolvedValue([
      {
        nameWithOwner: 'acme/orca',
        description: null,
        isPrivate: false,
        updatedAt: '2026-07-18T20:00:00Z',
        httpsUrl: 'https://github.com/acme/orca.git',
        sshUrl: 'git@github.com:acme/orca.git'
      }
    ])
    renderStep({ cloneUrl: 'git@github.com:existing/project.git', onCloneUrlChange })

    const trigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Choose from GitHub')
    )
    await act(async () => {
      trigger?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    const repository = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]')).find(
      (item) => item.textContent?.includes('acme/orca')
    )
    act(() => repository?.click())

    expect(onCloneUrlChange).toHaveBeenCalledWith('git@github.com:acme/orca.git')
  })
})
