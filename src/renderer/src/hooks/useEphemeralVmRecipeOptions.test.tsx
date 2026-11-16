// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEphemeralVmRecipeOptions } from './useEphemeralVmRecipeOptions'
import { ORCA_CLOUD_RECIPE_ID } from '../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { useAppStore } from '@/store'
import { requestOrcaCloudSelectionAfterSignIn } from '@/lib/orca-cloud-select-after-sign-in'
import { setOrcaCloudEnabledForTests } from './useOrcaCloudEnabled'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type RecipeListResult = Awaited<ReturnType<typeof window.api.ephemeralVm.listRecipes>>

const roots: Root[] = []

// Most cases run where Orca Cloud is rolled out; the rollout-flag case turns it off.
beforeEach(() => {
  setOrcaCloudEnabledForTests(true)
})

afterEach(async () => {
  setOrcaCloudEnabledForTests(null)
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
  enabled = true,
  customRecipesEnabled = true,
  repoExecutionHostId = 'local',
  repoConnectionId = null
}: {
  repoId: string
  initialRecipeId?: string
  enabled?: boolean
  customRecipesEnabled?: boolean
  repoExecutionHostId?: 'local' | `runtime:${string}`
  repoConnectionId?: string | null
}): React.JSX.Element {
  const state = useEphemeralVmRecipeOptions({
    enabled,
    customRecipesEnabled,
    repoId,
    repoIsGit: true,
    repoConnectionId,
    repoExecutionHostId,
    projectGroupTarget: false,
    initialRecipeId
  })
  return (
    <div>
      <span data-testid="repo">{repoId}</span>
      <span data-testid="recipes">{state.recipes.map((recipe) => recipe.id).join(',')}</span>
      <span data-testid="selected">{state.selectedRecipeId ?? 'none'}</span>
      <span data-testid="error">{state.error ?? 'none'}</span>
      <span data-testid="dropped">{state.orcaCloudDropped ?? 'none'}</span>
      <button
        type="button"
        data-testid="pick-cloud"
        onClick={() => state.setSelectedRecipeId(ORCA_CLOUD_RECIPE_ID)}
      />
      <button
        type="button"
        data-testid="pick-devbox"
        onClick={() => state.setSelectedRecipeId('devbox')}
      />
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
  it('offers only Orca Cloud, without recipe diagnostics, while custom recipes are off', async () => {
    installApi(
      vi.fn().mockResolvedValue({
        status: 'error',
        repoPath: '/repo',
        diagnostics: [{ index: 0, field: 'create', message: 'missing' }],
        message: 'orca.yaml is invalid',
        recipes: [
          { id: 'cloud', name: 'Orca Cloud', provider: 'orca-cloud', create: 'orca-cloud create' },
          { id: 'devbox', name: 'devbox', create: './create.sh' }
        ]
      })
    )
    const { container } = await render(<Harness repoId="repo-1" customRecipesEnabled={false} />)

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('cloud')
    )
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('none')
  })

  it('hides Orca Cloud, its setup row and any pick of it while the rollout flag is off', async () => {
    setOrcaCloudEnabledForTests(false)
    for (const orcaCloud of ['offered', 'needs-sign-in'] as const) {
      installApi(
        vi.fn().mockResolvedValue({
          ...result(['devbox']),
          recipes: [
            {
              id: 'cloud',
              name: 'Orca Cloud',
              provider: 'orca-cloud',
              create: 'orca-cloud create'
            },
            { id: 'devbox', name: 'devbox', create: './create.sh' }
          ],
          orcaCloud
        })
      )
      const { container } = await render(<Harness repoId="repo-1" initialRecipeId="cloud" />)
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('devbox')
      )
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('none')
    }
  })

  // Signed out (or no plan yet) the composer must still be able to pick Orca Cloud and reach
  // "Set up and start"; main only lists the recipe once the account can use it.
  it('offers Orca Cloud while the account still needs setup, and keeps an initial pick', async () => {
    for (const orcaCloud of ['needs-sign-in', 'needs-capability'] as const) {
      installApi(vi.fn().mockResolvedValue({ ...result([]), orcaCloud }))
      const { container } = await render(
        <Harness repoId="repo-1" customRecipesEnabled={false} initialRecipeId="cloud" />
      )
      await vi.waitFor(() =>
        expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('cloud')
      )
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('cloud')
    }
  })

  it('offers nothing extra when Orca Cloud is unavailable', async () => {
    installApi(vi.fn().mockResolvedValue({ ...result([]), orcaCloud: 'unavailable' }))
    const { container } = await render(
      <Harness repoId="repo-1" customRecipesEnabled={false} initialRecipeId="cloud" />
    )
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('none')
    )
    expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('')
  })

  it('reloads when the account signs in, so Orca Cloud appears without switching projects', async () => {
    const listRecipes = vi
      .fn()
      .mockResolvedValueOnce({ ...result([]), orcaCloud: 'needs-sign-in' })
      .mockResolvedValueOnce({
        ...result([]),
        recipes: [
          { id: 'cloud', name: 'Orca Cloud', provider: 'orca-cloud', create: 'orca-cloud create' }
        ],
        orcaCloud: 'offered'
      })
    installApi(listRecipes)
    const { container } = await render(<Harness repoId="repo-1" customRecipesEnabled={false} />)
    await vi.waitFor(() => expect(listRecipes).toHaveBeenCalledTimes(1))

    await act(async () =>
      useAppStore.setState({
        orcaProfileAuthStatus: {
          activeProfileId: 'p',
          configured: true,
          state: 'connected',
          persistence: 'encrypted',
          capabilities: { flags: { sandbox: true }, refreshedAt: 1 }
        }
      })
    )

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('cloud')
    )
  })

  it('selects Orca Cloud after signing in from the picker, even under StrictMode', async () => {
    const listRecipes = vi
      .fn()
      .mockResolvedValueOnce({ ...result([]), orcaCloud: 'needs-sign-in' })
      .mockResolvedValue({
        ...result([]),
        recipes: [
          { id: 'cloud', name: 'Orca Cloud', provider: 'orca-cloud', create: 'orca-cloud create' }
        ],
        orcaCloud: 'offered'
      })
    installApi(listRecipes)
    useAppStore.setState({ orcaProfileAuthStatus: null })
    const { container } = await render(
      <StrictMode>
        <Harness repoId="repo-1" customRecipesEnabled={false} />
      </StrictMode>
    )
    await vi.waitFor(() => expect(listRecipes).toHaveBeenCalled())
    requestOrcaCloudSelectionAfterSignIn()

    await act(async () =>
      useAppStore.setState({
        orcaProfileAuthStatus: {
          activeProfileId: 'p',
          configured: true,
          state: 'connected',
          persistence: 'encrypted',
          capabilities: { flags: { sandbox: true }, refreshedAt: 1 }
        }
      })
    )

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('cloud')
    )
  })

  // A project cloned only on a remote server still offers Orca Cloud (it starts
  // from GitHub). Main has no clone to read, so its "not found" never surfaces, and no orca.yaml
  // recipe from this computer is offered for it.
  it('offers only Orca Cloud for a project cloned on a remote server, with no local recipe error', async () => {
    const listRecipes = vi.fn().mockResolvedValue({
      status: 'error',
      repoPath: null,
      diagnostics: [],
      recipes: [{ id: 'devbox', name: 'devbox', create: './create.sh' }],
      message: 'Repo not found: repo-runtime',
      orcaCloud: 'offered'
    })
    installApi(listRecipes)

    const { container } = await render(
      <Harness repoId="repo-runtime" repoExecutionHostId="runtime:windows-2" />
    )

    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('cloud')
    )
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('none')
  })

  it('offers nothing for a remote-server project while Orca Cloud is unavailable', async () => {
    installApi(vi.fn().mockResolvedValue({ ...result([]), orcaCloud: 'unavailable' }))
    const { container } = await render(
      <Harness repoId="repo-runtime" repoExecutionHostId="runtime:windows-2" />
    )
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid="selected"]')?.textContent).toBe('none')
    )
    expect(container.querySelector('[data-testid="recipes"]')?.textContent).toBe('')
  })

  // Picking Orca Cloud, then another project, reset Run on to this computer.
  describe('a picked Orca Cloud across project changes', () => {
    const CLOUD = {
      id: ORCA_CLOUD_RECIPE_ID,
      name: 'Orca Cloud',
      provider: 'orca-cloud' as const,
      create: 'orca-cloud create'
    }
    const withCloud = (ids: string[] = []): RecipeListResult => ({
      ...result(ids),
      recipes: [CLOUD, ...ids.map((id) => ({ id, name: id, create: `create-${id}` }))],
      orcaCloud: 'offered'
    })
    const text = (container: HTMLElement, id: string) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent
    const pick = async (container: HTMLElement, id: string) =>
      act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)?.click())

    it('stays picked when the new project can use it, without flashing back to this computer', async () => {
      const next = deferred<RecipeListResult>()
      installApi(
        vi
          .fn()
          .mockResolvedValueOnce(withCloud(['devbox']))
          .mockReturnValueOnce(next.promise)
      )
      const { root, container } = await render(<Harness repoId="repo-1" />)
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain(ORCA_CLOUD_RECIPE_ID))
      await pick(container, 'pick-cloud')
      expect(text(container, 'selected')).toBe(ORCA_CLOUD_RECIPE_ID)

      await act(async () => root.render(<Harness repoId="repo-2" />))
      // While the new project's options load, Run on still reads Orca Cloud.
      expect(text(container, 'selected')).toBe(ORCA_CLOUD_RECIPE_ID)
      await act(async () => next.resolve(withCloud()))
      expect(text(container, 'selected')).toBe(ORCA_CLOUD_RECIPE_ID)
      expect(text(container, 'dropped')).toBe('none')
    })

    it('falls back only when the new project can’t use it, and says why', async () => {
      installApi(
        vi
          .fn()
          .mockResolvedValueOnce(withCloud())
          .mockResolvedValueOnce({ ...result([]), orcaCloud: 'unavailable' })
      )
      const { root, container } = await render(<Harness repoId="repo-1" />)
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain(ORCA_CLOUD_RECIPE_ID))
      await pick(container, 'pick-cloud')
      await act(async () => root.render(<Harness repoId="repo-2" />))
      await vi.waitFor(() => expect(text(container, 'selected')).toBe('none'))
      expect(text(container, 'dropped')).toBe('unavailable')

      // The next pick clears the reason.
      await pick(container, 'pick-cloud')
      expect(text(container, 'dropped')).toBe('none')
    })

    it('a project on another machine (SSH): falls back and says it lives elsewhere', async () => {
      installApi(vi.fn().mockResolvedValueOnce(withCloud()))
      const { root, container } = await render(<Harness repoId="repo-1" />)
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain(ORCA_CLOUD_RECIPE_ID))
      await pick(container, 'pick-cloud')
      await act(async () => root.render(<Harness repoId="repo-ssh" repoConnectionId="ssh-1" />))
      expect(text(container, 'selected')).toBe('none')
      expect(text(container, 'dropped')).toBe('elsewhere')
    })

    it('Orca Cloud not answering for the new project: falls back with unreachable', async () => {
      installApi(
        vi.fn().mockResolvedValueOnce(withCloud()).mockRejectedValueOnce(new Error('offline'))
      )
      const { root, container } = await render(
        <Harness repoId="repo-1" customRecipesEnabled={false} />
      )
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain(ORCA_CLOUD_RECIPE_ID))
      await pick(container, 'pick-cloud')
      await act(async () => root.render(<Harness repoId="repo-2" customRecipesEnabled={false} />))
      await vi.waitFor(() => expect(text(container, 'dropped')).toBe('unreachable'))
      expect(text(container, 'selected')).toBe('none')
    })

    it('a project’s own recipe still doesn’t carry to another project', async () => {
      installApi(
        vi
          .fn()
          .mockResolvedValueOnce(withCloud(['devbox']))
          .mockResolvedValueOnce(withCloud(['devbox']))
      )
      const { root, container } = await render(<Harness repoId="repo-1" />)
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain('devbox'))
      await pick(container, 'pick-devbox')
      await act(async () => root.render(<Harness repoId="repo-2" />))
      await vi.waitFor(() => expect(text(container, 'recipes')).toContain('devbox'))
      expect(text(container, 'selected')).toBe('none')
      expect(text(container, 'dropped')).toBe('none')
    })
  })
})
