import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startSidebarWorkspaceCreateAction } from './sidebar-workspace-create-action'
import type { GlobalSettings } from '../../../../shared/types'
import type { QuickCreateDefaultWorkspaceArgs } from '@/lib/quick-create-default-workspace'

type QuickCreateFn = (args: QuickCreateDefaultWorkspaceArgs) => Promise<void>

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    quickCreateWorkspaceWithDefaultAgent: true,
    defaultTuiAgent: 'codex',
    ...overrides
  } as GlobalSettings
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('startSidebarWorkspaceCreateAction', () => {
  let quickCreateInFlight: { current: boolean }
  let setQuickCreating: ReturnType<typeof vi.fn<(creating: boolean) => void>>
  let openComposer: ReturnType<typeof vi.fn<() => void>>
  let quickCreate: ReturnType<typeof vi.fn<QuickCreateFn>>

  beforeEach(() => {
    quickCreateInFlight = { current: false }
    setQuickCreating = vi.fn<(creating: boolean) => void>()
    openComposer = vi.fn<() => void>()
    quickCreate = vi.fn<QuickCreateFn>().mockResolvedValue(undefined)
  })

  it('does nothing when workspace creation is unavailable', () => {
    startSidebarWorkspaceCreateAction({
      canCreateWorkspace: false,
      settings: makeSettings(),
      quickCreateInFlight,
      setQuickCreating,
      openComposer,
      quickCreate
    })

    expect(openComposer).not.toHaveBeenCalled()
    expect(quickCreate).not.toHaveBeenCalled()
  })

  it('opens the composer when quick-create is disabled', () => {
    startSidebarWorkspaceCreateAction({
      canCreateWorkspace: true,
      settings: makeSettings({ quickCreateWorkspaceWithDefaultAgent: false }),
      quickCreateInFlight,
      setQuickCreating,
      openComposer,
      quickCreate
    })

    expect(openComposer).toHaveBeenCalledTimes(1)
    expect(quickCreate).not.toHaveBeenCalled()
  })

  it('opens the composer when no default agent is configured', () => {
    startSidebarWorkspaceCreateAction({
      canCreateWorkspace: true,
      settings: makeSettings({ defaultTuiAgent: null }),
      quickCreateInFlight,
      setQuickCreating,
      openComposer,
      quickCreate
    })

    expect(openComposer).toHaveBeenCalledTimes(1)
    expect(quickCreate).not.toHaveBeenCalled()
  })

  it('starts quick-create when the setting and default agent are configured', () => {
    startSidebarWorkspaceCreateAction({
      canCreateWorkspace: true,
      settings: makeSettings(),
      quickCreateInFlight,
      setQuickCreating,
      openComposer,
      quickCreate
    })

    expect(openComposer).not.toHaveBeenCalled()
    expect(quickCreateInFlight.current).toBe(true)
    expect(setQuickCreating).toHaveBeenCalledWith(true)
    expect(quickCreate).toHaveBeenCalledWith({ openModalFallback: openComposer })
  })

  it('guards duplicate clicks until the quick-create attempt settles', async () => {
    const pending = deferred()
    quickCreate.mockReturnValue(pending.promise)

    const args = {
      canCreateWorkspace: true,
      settings: makeSettings(),
      quickCreateInFlight,
      setQuickCreating,
      openComposer,
      quickCreate
    }

    startSidebarWorkspaceCreateAction(args)
    startSidebarWorkspaceCreateAction(args)

    expect(quickCreate).toHaveBeenCalledTimes(1)
    expect(openComposer).not.toHaveBeenCalled()
    expect(quickCreateInFlight.current).toBe(true)

    pending.resolve()
    await pending.promise
    await Promise.resolve()

    expect(quickCreateInFlight.current).toBe(false)
    expect(setQuickCreating).toHaveBeenLastCalledWith(false)
  })
})
