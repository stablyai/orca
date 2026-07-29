// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EphemeralVmsPane } from './EphemeralVmsPane'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn()
}))

const storeMocks = vi.hoisted(() => ({
  openModal: vi.fn()
}))

const mockStoreState = {
  activeRepoId: null,
  activeWorktreeId: null,
  openModal: storeMocks.openModal,
  recordFeatureInteraction: vi.fn(),
  projects: [],
  repos: [],
  settings: null,
  worktreesByRepo: {}
}

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(mockStoreState), {
    getState: () => mockStoreState
  })
}))

const roots: Root[] = []

async function renderPane(): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<EphemeralVmsPane />)
  })
  return container
}

describe('EphemeralVmsPane', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    toastMocks.error.mockClear()
    storeMocks.openModal.mockClear()
    let pluginChangeListener: ((event: { contentPacksChanged: boolean }) => void) | null = null
    Object.assign(globalThis.window, {
      api: {
        ephemeralVm: {
          listRecipeCatalog: vi.fn().mockResolvedValue([
            {
              repoId: 'repo-1',
              repoName: 'Repo',
              repoPath: '/repo',
              diagnostics: [],
              recipes: [
                {
                  id: 'cloud-sandbox',
                  name: 'Cloud Sandbox',
                  create: './scripts/orca-vm/cloud-sandbox.start.sh',
                  destroy: './scripts/orca-vm/cloud-sandbox.cleanup.sh'
                }
              ]
            }
          ]),
          doctor: vi.fn().mockResolvedValue({
            recipeId: 'cloud-sandbox',
            repoPath: '/repo',
            ok: true,
            checks: []
          })
        },
        skills: {
          discover: vi.fn().mockResolvedValue({ skills: [] })
        },
        cli: {
          getInstallStatus: vi.fn().mockResolvedValue({ state: 'installed', pathConfigured: true }),
          getWslInstallStatus: vi
            .fn()
            .mockResolvedValue({ state: 'installed', pathConfigured: true })
        },
        platform: {
          get: vi.fn().mockReturnValue({ platform: 'darwin' })
        },
        ui: {
          writeClipboardText: vi.fn().mockResolvedValue(undefined)
        },
        plugins: {
          onChanged: vi.fn((listener) => {
            pluginChangeListener = listener
            return () => {
              pluginChangeListener = null
            }
          }),
          emitContentChanged: () => pluginChangeListener?.({ contentPacksChanged: true })
        }
      }
    })
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    document.body.replaceChildren()
  })

  it('renders the skill panel and recipe, and opens the composer with the recipe selected', async () => {
    const container = await renderPane()

    await vi.waitFor(() => expect(container.textContent).toContain('Cloud Sandbox'))
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Per-Workspace Environments skill')
    )
    expect(container.textContent).toContain('What the skill does, with you')
    const useButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Use in workspace'
    )
    expect(useButton).toBeDefined()

    await act(async () => {
      useButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(storeMocks.openModal).toHaveBeenCalledWith('new-workspace-composer', {
      initialRepoId: 'repo-1',
      initialEphemeralVmRecipeId: 'cloud-sandbox',
      telemetrySource: 'settings'
    })
  })

  it('refreshes the catalog when plugin content changes', async () => {
    const listRecipeCatalog = window.api.ephemeralVm.listRecipeCatalog as ReturnType<typeof vi.fn>
    const container = await renderPane()
    await vi.waitFor(() => expect(container.textContent).toContain('Cloud Sandbox'))
    listRecipeCatalog.mockResolvedValueOnce([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        repoPath: '/repo',
        diagnostics: [],
        recipes: [{ id: 'plugin-recipe', name: 'Plugin Recipe', create: 'create' }]
      }
    ])

    await act(async () => {
      ;(window.api.plugins as never as { emitContentChanged: () => void }).emitContentChanged()
    })

    await vi.waitFor(() => expect(container.textContent).toContain('Plugin Recipe'))
    expect(listRecipeCatalog).toHaveBeenCalledTimes(2)
  })

  it('ignores an older refresh that finishes after a plugin-content refresh', async () => {
    const listRecipeCatalog = window.api.ephemeralVm.listRecipeCatalog as ReturnType<typeof vi.fn>
    let resolveInitial!: (catalog: unknown[]) => void
    listRecipeCatalog
      .mockReset()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve
        })
      )
      .mockResolvedValueOnce([
        {
          repoId: 'repo-1',
          repoName: 'Repo',
          repoPath: '/repo',
          diagnostics: [],
          recipes: [{ id: 'new', name: 'Newest Recipe', create: 'create' }]
        }
      ])

    const container = await renderPane()
    await act(async () => {
      ;(window.api.plugins as never as { emitContentChanged: () => void }).emitContentChanged()
    })
    await vi.waitFor(() => expect(container.textContent).toContain('Newest Recipe'))

    await act(async () => {
      resolveInitial([
        {
          repoId: 'repo-1',
          repoName: 'Repo',
          repoPath: '/repo',
          diagnostics: [],
          recipes: [{ id: 'stale', name: 'Stale Recipe', create: 'create' }]
        }
      ])
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Newest Recipe')
    expect(container.textContent).not.toContain('Stale Recipe')
  })
})
