// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'

const checkRuntimeHooksMock = vi.hoisted(() =>
  vi.fn<
    (hostId: string, repoId: string, options?: { background?: boolean }) => Promise<HookCheckResult>
  >()
)
vi.mock('@/runtime/runtime-hooks-client', () => ({ checkRuntimeHooks: checkRuntimeHooksMock }))

type Params = Parameters<typeof useSettingsRepoScrollEffects>
type HooksMap = Record<string, unknown>

const repo: Repo = {
  id: 'repo-1',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

function renderEffects(): { map: () => HooksMap } {
  let map: HooksMap = {}
  const setRepoHooksMap = (update: HooksMap | ((previous: HooksMap) => HooksMap)): void => {
    map = typeof update === 'function' ? update(map) : update
  }
  const ref = <T,>(current: T): { current: T } => ({ current })
  renderHook(() =>
    useSettingsRepoScrollEffects(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hooks effect reads only these fields; the scroll effect sees an idle section.
      {
        activeSectionId: 'general',
        pendingNavRequestTick: 0,
        repos: [repo],
        setActiveSectionId: vi.fn(),
        setPendingNavRequestTick: vi.fn(),
        setRepoHooksMap,
        setSettingsSearchQuery: vi.fn(),
        settingsSearchQuery: ''
      } as unknown as Params[0],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refs the effects read; none hold a pending target.
      {
        contentScrollRef: ref(null),
        pendingNavSectionRef: ref(null),
        pendingScrollTargetRef: ref(null),
        pendingScrollTargetWatchRef: ref(null),
        pendingSubsectionScrollFrameRef: ref(null),
        repoHooksRequestSeqRef: ref(0)
      } as unknown as Params[1],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation fields the scroll effect reads.
      { visibleNavSections: [], visibleSectionIds: new Set(['general']) } as unknown as Params[2],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hooks effect reads only neededRepos.
      { neededRepos: [repo] } as unknown as Params[3]
    )
  )
  return { map: () => map }
}

// G6: showing a project's settings is no act on its WSL distro.
describe('settings orca.yaml inspection', () => {
  beforeEach(() => {
    checkRuntimeHooksMock.mockReset()
  })
  // An unmounted hook must drop its retry listeners, or they fire into the next case.
  afterEach(cleanup)

  it('re-asks when the window comes back and records the distro once it runs', async () => {
    const hooks = { scripts: { setup: 'pnpm i' } }
    checkRuntimeHooksMock
      .mockResolvedValueOnce({
        status: 'error',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false,
        unavailable: 'wsl-distro-stopped'
      })
      .mockResolvedValueOnce({ hasHooks: true, hooks, mayNeedUpdate: false })
    const { map } = renderEffects()
    await waitFor(() => expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(map()).toEqual({})

    await act(async () => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(Object.values(map())).toEqual([expect.objectContaining({ hooks })]))
    expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(2)
  })

  it('re-asks on a short timer while a repo is still unread', async () => {
    vi.useFakeTimers()
    try {
      checkRuntimeHooksMock
        .mockResolvedValueOnce({
          status: 'error',
          hasHooks: false,
          hooks: null,
          mayNeedUpdate: false,
          unavailable: 'wsl-distro-unverifiable'
        })
        .mockResolvedValueOnce({ hasHooks: false, hooks: null, mayNeedUpdate: false })
      const { map } = renderEffects()
      await act(async () => {})
      // An unverifiable distro is unread too, never stored as "no orca.yaml".
      expect(map()).toEqual({})

      await act(async () => vi.advanceTimersByTime(10_000))

      expect(checkRuntimeHooksMock).toHaveBeenCalledTimes(2)
      expect(Object.keys(map())).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
