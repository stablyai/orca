// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEphemeralVmRecipeOptions } from './useEphemeralVmRecipeOptions'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type RecipeListResult = Awaited<ReturnType<typeof window.api.ephemeralVm.listRecipes>>

const roots: Root[] = []

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function result(ids: string[]): RecipeListResult {
  return {
    status: 'ok',
    repoPath: '/repo',
    diagnostics: [],
    recipes: ids.map((id) => ({ id, name: id, create: `create-${id}` }))
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function installApi(listRecipes: ReturnType<typeof vi.fn>): {
  emit: (contentPacksChanged?: boolean) => void
} {
  let listener: ((event: { contentPacksChanged: boolean }) => void) | null = null
  window.api = {
    ephemeralVm: { listRecipes },
    plugins: {
      onChanged: vi.fn((nextListener) => {
        listener = nextListener
        return () => {
          listener = null
        }
      })
    }
  } as never
  return {
    emit: (contentPacksChanged = true) => listener?.({ contentPacksChanged })
  }
}

function Harness({
  repoId,
  initialRecipeId,
  enabled = true
}: {
  repoId: string
  initialRecipeId?: string
  enabled?: boolean
}): React.JSX.Element {
  const state = useEphemeralVmRecipeOptions({
    enabled,
    repoId,
    repoIsGit: true,
    repoConnectionId: null,
    projectGroupTarget: false,
    initialRecipeId
  })
  return (
    <div>
      <span data-testid="repo">{repoId}</span>
      <span data-testid="recipes">{state.recipes.map((recipe) => recipe.id).join(',')}</span>
      <span data-testid="selected">{state.selectedRecipeId ?? 'none'}</span>
    </div>
  )
}

async function render(
  element: React.ReactNode
): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(element))
  return { root, container }
}

describe('useEphemeralVmRecipeOptions', () => {
  it('refetches on plugin lifecycle changes and clears only a removed selection', async () => {
    const listRecipes = vi
      .fn()
      .mockResolvedValueOnce(result(['repo', 'plugin']))
      .mockResolvedValueOnce(result(['repo', 'plugin', 'new-plugin']))
      .mockResolvedValueOnce(result(['repo']))
    const changes = installApi(listRecipes)
    const { container } = await render(<Harness repoId="repo-1" initialRecipeId="plugin" />)
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('plugin')
    )

    await act(async () => changes.emit())
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="recipes"]')?.textContent).toContain(
        'new-plugin'
      )
    )
    expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('plugin')

    await act(async () => changes.emit())
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('none')
    )
    expect(container.querySelector('[data-testid="repo"]')?.textContent).toBe('repo-1')
  })

  it('ignores a stale recipe response after switching projects', async () => {
    const first = deferred<RecipeListResult>()
    const second = deferred<RecipeListResult>()
    installApi(vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise))
    const { root, container } = await render(<Harness repoId="repo-1" />)

    await act(async () => root.render(<Harness repoId="repo-2" />))
    await act(async () => second.resolve(result(['new-project'])))
    await act(async () => first.resolve(result(['stale-project'])))

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('new-project')
    )
    expect(container.textContent).not.toContain('stale-project')
  })

  it('does not probe recipes while the feature is disabled', async () => {
    const listRecipes = vi.fn().mockResolvedValue(result(['hidden']))
    installApi(listRecipes)

    await render(<Harness repoId="repo-1" enabled={false} />)

    expect(listRecipes).not.toHaveBeenCalled()
  })
})
