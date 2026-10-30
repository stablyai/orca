// @vitest-environment happy-dom
// A restored Projects page lists the board's views from a mount effect with no click: it must not
// ask to start the stopped WSL distro gh lives in (E9). Picker clicks do.
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, listProjectViewsMock } = vi.hoisted(() => ({
  state: {
    settings: {
      githubProjects: {
        activeProject: { owner: 'acme', ownerType: 'organization', number: 7 },
        lastViewByProject: {}
      }
    },
    projectViewCache: {},
    fetchProjectViewTable: async () => ({ ok: false, error: { type: 'unknown', message: '' } })
  },
  listProjectViewsMock: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({ lookupSlugMatches: () => [], ready: true })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))

import { useProjectViewTable } from './useProjectViewTable'
import { listProjectViewsForRuntime } from './project-picker-runtime'

beforeEach(() => {
  listProjectViewsMock.mockReset().mockResolvedValue({ ok: true, views: [] })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { listProjectViews: listProjectViewsMock } }
  })
})

afterEach(() => {
  cleanup()
})

describe('listing a board’s views', () => {
  it('from the mount effect never asks to wake the distro', async () => {
    renderHook(() => useProjectViewTable(new Set(), { kind: 'local' }))

    await waitFor(() => expect(listProjectViewsMock).toHaveBeenCalled())
    for (const [args] of listProjectViewsMock.mock.calls) {
      expect(args).not.toHaveProperty('wakeWslDistro')
    }
  })

  it('from a picker click asks to wake it', async () => {
    const args = { owner: 'acme', ownerType: 'organization', projectNumber: 7 } as const

    await listProjectViewsForRuntime({ kind: 'local' }, args, { wake: true })

    expect(listProjectViewsMock).toHaveBeenCalledWith({ ...args, wakeWslDistro: true })
  })
})
