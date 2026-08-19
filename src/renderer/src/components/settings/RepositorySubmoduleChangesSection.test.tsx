// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { RepositorySubmoduleChangesSection } from './RepositorySubmoduleChangesSection'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderSection(repo: Partial<Repo>, updateRepo: (repoId: string, updates: object) => void) {
  act(() => {
    root.render(
      <RepositorySubmoduleChangesSection
        repo={{ id: 'repo-1', displayName: 'monorepo', path: '/repo', ...repo } as Repo}
        updateRepo={updateRepo}
        forceVisible
      />
    )
  })
}

describe('RepositorySubmoduleChangesSection', () => {
  it('reflects the stored opt-in and writes the toggled value back to the repo', () => {
    const updateRepo = vi.fn()
    renderSection({ showSubmoduleChanges: true }, updateRepo)

    const toggle = container.querySelector('button[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('true')

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { showSubmoduleChanges: false })
  })

  it('defaults to off when the repo has never opted in', () => {
    const updateRepo = vi.fn()
    renderSection({}, updateRepo)

    const toggle = container.querySelector('button[role="switch"]')
    expect(toggle?.getAttribute('aria-checked')).toBe('false')

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateRepo).toHaveBeenCalledWith('repo-1', { showSubmoduleChanges: true })
  })
})
