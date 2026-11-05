// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EphemeralVmsPane } from './EphemeralVmsPane'

vi.mock('@/components/terminal-pane/TerminalPane', () => ({
  default: () => {
    throw new Error('This suite must not render a terminal pane')
  }
}))

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

vi.mock('@/store/index', () => ({
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
