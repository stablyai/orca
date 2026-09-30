// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { useAppStore } from '../../store'
import { RepositoryPane } from './RepositoryPane'
import { TooltipProvider } from '../ui/tooltip'

// Why client rendering, not renderToStaticMarkup: zustand serves getServerSnapshot during
// static rendering, so the pane would read the initial empty query and the filtered path
// this test exists to cover would never run.

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

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
  useAppStore.setState({ settingsSearchQuery: '', settingsSearchInputQuery: '' })
})

function renderPaneWithQuery(query: string): void {
  useAppStore.setState({ settingsSearchQuery: query, settingsSearchInputQuery: query })
  act(() => {
    root.render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RepositoryPane, {
          repo,
          yamlHooks: null,
          hasHooksFile: false,
          hooksInspectionReady: true,
          mayNeedUpdate: false,
          updateRepo: vi.fn(),
          removeProject: vi.fn()
        } as never)
      )
    )
  })
}

describe('RepositoryPane submodule search', () => {
  it('renders the submodule opt-in for a query that matches only that section', () => {
    renderPaneWithQuery('submodule')

    expect(container.textContent).toContain('Show Submodule Changes')
    expect(
      container.querySelector('[role="switch"][aria-label="Show Submodule Changes"]')
    ).not.toBe(null)
  })

  it('hides it for a query that matches nothing in this pane', () => {
    renderPaneWithQuery('zzzznotathing')

    expect(container.textContent).not.toContain('Show Submodule Changes')
  })
})
