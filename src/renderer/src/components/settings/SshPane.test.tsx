// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSshConfigPassiveSyncForTests } from '../../lib/ssh-config-passive-sync'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SshPane } from './SshPane'

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  toast: vi.fn(),
  recordReadoptions: vi.fn(),
  recordInteraction: vi.fn(),
  requestRemove: vi.fn(),
  requestBulkRemove: vi.fn(),
  openSettingsTarget: vi.fn(),
  connectionStates: new Map<string, SshConnectionState>()
}))
vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: vi.fn() })
}))
vi.mock('@/store', () => {
  const state = {
    sshConnectionStates: mocks.connectionStates,
    recordFeatureInteraction: mocks.recordInteraction,
    setSshTargetsMetadata: vi.fn(),
    clearRemovedSshTargetState: vi.fn(),
    recordSshRepoReadoptions: mocks.recordReadoptions,
    openSettingsTarget: mocks.openSettingsTarget,
    repos: [],
    worktreesByRepo: {}
  }
  return {
    useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/ssh/ssh-old-relay-terminals-action', () => ({
  useSshConnectFailureToast: () => vi.fn()
}))
vi.mock('./SshTargetForm', () => ({ SshTargetForm: () => null, EMPTY_FORM: {} }))
vi.mock('./SshTargetDestructiveActions', () => ({
  SshTargetDestructiveActions: ({
    children
  }: {
    children: (actions: {
      busyActionForTarget: () => undefined
      requestRemove: () => void
      requestBulkRemove: () => void
    }) => ReactNode
  }) =>
    children({
      busyActionForTarget: () => undefined,
      requestRemove: mocks.requestRemove,
      requestBulkRemove: mocks.requestBulkRemove
    })
}))
vi.mock('./SshTargetServerStatus', () => ({
  SshTargetServerStatusLine: () => null,
  SshTargetServerMenuItems: () => null,
  SshTargetServerDialogs: () => null
}))
// Radix menus open on pointer events happy-dom doesn't model; render items as plain buttons.
vi.mock('../ui/dropdown-menu', () => {
  const passthrough = ({ children }: { children?: ReactNode }): ReactNode => children
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, onSelect }: { children?: ReactNode; onSelect?: () => void }) => (
      <button role="menuitem" onClick={() => onSelect?.()}>
        {children}
      </button>
    )
  }
})
vi.mock('./SshTargetsEmptyState', () => ({ SshTargetsEmptyState: () => null }))

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement | null = null

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  container?.remove()
  container = null
  root = null
  Reflect.deleteProperty(window, 'api')
  resetSshConfigPassiveSyncForTests()
  mocks.connectionStates.clear()
  vi.clearAllMocks()
  await setRendererUiLanguage('en')
})

describe('SSH import count notices', () => {
  it.each(['en', 'ko'] as const)(
    'uses complete %s sentences and preserves the no-change branch',
    async (language) => {
      await setRendererUiLanguage(language)
      const importConfig = vi.fn(
        async (_args?: {
          reAdopt?: boolean
        }): Promise<{ targets: SshTarget[]; repoReadoptions: never[] }> => ({
          targets: [],
          repoReadoptions: []
        })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ssh: { importConfig, listTargets: async () => [] } }
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      await act(async () => {
        root?.render(<SshPane />)
      })
      expect(importConfig).toHaveBeenCalledTimes(1)
      expect(mocks.success).not.toHaveBeenCalled()
      const button = Array.from(container.querySelectorAll('button')).find((entry) =>
        entry.textContent?.includes(
          language === 'ko' ? '~/.ssh/config 동기화' : 'Sync ~/.ssh/config'
        )
      )
      expect(button).toBeTruthy()
      for (const count of [0, 1, 2]) {
        importConfig.mockResolvedValueOnce({
          targets: Array.from({ length: count }, (_, index) => ({
            id: `fixture-${index}`,
            label: 'Fixture',
            host: 'fixture.example.test',
            port: 22,
            username: 'fixture'
          })),
          repoReadoptions: []
        })
        await act(async () => {
          button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        if (count === 0) {
          expect(mocks.toast).toHaveBeenLastCalledWith(
            language === 'ko'
              ? '~/.ssh/config가 이미 동기화되어 있습니다.'
              : '~/.ssh/config already in sync'
          )
          expect(mocks.success).not.toHaveBeenCalled()
        } else {
          expect(mocks.success).toHaveBeenLastCalledWith(
            language === 'ko'
              ? `서버 ${count}개를 동기화했습니다.`
              : `Synced ${count} server${count === 1 ? '' : 's'}`
          )
        }
      }
      expect(importConfig).toHaveBeenCalledTimes(4)
      // Sync must never lift the tombstones of hosts removed in Orca.
      expect(importConfig.mock.calls.slice(1)).toEqual([
        [{ reAdopt: false }],
        [{ reAdopt: false }],
        [{ reAdopt: false }]
      ])
      expect(mocks.recordInteraction).toHaveBeenCalledTimes(3)
    }
  )
})

// #28901: main refuses to remove a managed server's host, which surfaced as a raw IPC error.
describe('removing a managed server host', () => {
  it('points to the host’s Orca server row instead of a removal main refuses', async () => {
    const removeTarget = vi.fn()
    const managed: SshTarget = {
      id: 'box',
      label: 'Build box',
      host: 'box.example.test',
      port: 22,
      username: 'dev',
      orcadFence: { environmentId: 'env-box' }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          importConfig: async () => ({ targets: [], repoReadoptions: [] }),
          listTargets: async () => [managed],
          removeTarget
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <SshPane />
        </TooltipProvider>
      )
    })
    const remove = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === 'Remove…'
    )
    expect(remove).toBeTruthy()
    await act(async () => {
      remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.requestRemove).not.toHaveBeenCalled()
    expect(removeTarget).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Orca runs on Build box')
    const open = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open Remote Orca Servers'
    )
    await act(async () => {
      open?.click()
    })
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      sectionId: 'managed-servers'
    })
  })
})

describe('bulk removal from SSH settings', () => {
  const host = (id: string, extra: Partial<SshTarget> = {}): SshTarget => ({
    id,
    label: id,
    host: `${id}.example.test`,
    port: 22,
    username: 'dev',
    source: 'ssh-config',
    ...extra
  })

  async function renderPane(targets: SshTarget[]): Promise<HTMLDivElement> {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          importConfig: async () => ({ targets: [], repoReadoptions: [] }),
          listTargets: async () => targets,
          removeTarget: vi.fn(),
          testConnection: async ({ targetId }: { targetId: string }) =>
            targetId === 'beta' ? { success: false, error: 'timed out' } : { success: true }
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <SshPane />
        </TooltipProvider>
      )
    })
    return container
  }

  function checkbox(host: HTMLElement, label: string): HTMLElement {
    return host.querySelector<HTMLElement>(`[aria-label="Select ${label}"]`)!
  }

  it('confirms the plain hosts once and skips the managed server host', async () => {
    const pane = await renderPane([
      host('alpha'),
      host('beta'),
      host('gamma', { orcadFence: { environmentId: 'env-gamma' } })
    ])
    await act(async () => checkbox(pane, 'alpha').click())
    // Shift-click selects the range alpha..gamma.
    await act(async () => {
      checkbox(pane, 'gamma').dispatchEvent(
        new MouseEvent('click', { bubbles: true, shiftKey: true })
      )
    })
    expect(pane.textContent).toContain('3 selected')
    const remove = Array.from(pane.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove 3'
    )
    await act(async () => remove?.click())
    expect(mocks.requestRemove).not.toHaveBeenCalled()
    expect(mocks.requestBulkRemove).toHaveBeenCalledWith({
      targets: [
        { id: 'alpha', label: 'alpha' },
        { id: 'beta', label: 'beta' }
      ],
      connectedCount: 0
    })
  })

  it('tests the selection and reports it in one toast', async () => {
    mocks.connectionStates.set('gamma', {
      targetId: 'gamma',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    const pane = await renderPane([host('alpha'), host('beta'), host('gamma')])
    await act(async () => checkbox(pane, 'alpha').click())
    await act(async () => checkbox(pane, 'beta').click())
    await act(async () => checkbox(pane, 'gamma').click())
    const test = Array.from(pane.querySelectorAll('button')).find(
      (button) => button.textContent === 'Test'
    )
    await act(async () => test?.click())
    // A connected host is skipped, as on its own row.
    expect(mocks.toast).toHaveBeenCalledWith('1 reachable · 1 failed · 1 already connected', {
      description: 'beta: timed out'
    })
  })

  it('drops hosts the filter hides from the selection, so they are never removed unseen', async () => {
    const names = ['alpha', 'beta', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']
    const pane = await renderPane(names.map((name) => host(name)))
    await act(async () => checkbox(pane, 'alpha').click())
    await act(async () => checkbox(pane, 'beta').click())
    expect(pane.textContent).toContain('2 selected')
    const filter = pane.querySelector<HTMLInputElement>('input[aria-label="Filter hosts"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        filter,
        'beta'
      )
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(pane.textContent).toContain('1 selected')
    const remove = Array.from(pane.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove 1'
    )
    await act(async () => remove?.click())
    expect(mocks.requestRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'beta' }))
    expect(mocks.requestBulkRemove).not.toHaveBeenCalled()

    // When a filter hides the last selected host, the bar says so instead of just vanishing.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'c3')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(pane.textContent).not.toContain('selected ')
    expect(pane.textContent).toContain('1 hidden host deselected')
  })

  it('keeps an active filter clearable when a reload drops the list under the threshold', async () => {
    const names = ['alpha', 'beta', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']
    let listed = names.map((name) => host(name))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          importConfig: async () => ({ targets: [], repoReadoptions: [] }),
          listTargets: async () => listed
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<SshPane />)
    })
    const filter = () =>
      container?.querySelector<HTMLInputElement>('input[aria-label="Filter hosts"]') ?? null
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        filter(),
        'zzz'
      )
      filter()?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    listed = listed.slice(0, 3)
    const sync = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Sync ~/.ssh/config'
    )
    await act(async () => sync?.click())
    expect(container.querySelectorAll('[data-ssh-target-card]')).toHaveLength(0)
    expect(filter()?.value).toBe('zzz')
  })

  it('groups hosts by where they came from', async () => {
    const pane = await renderPane([host('alpha'), host('mine', { source: 'manual' })])
    const groups = Array.from(pane.querySelectorAll('[data-ssh-target-group]')).map((group) => [
      group.getAttribute('data-ssh-target-group'),
      group.querySelectorAll('[data-ssh-target-card]').length
    ])
    expect(groups).toEqual([
      ['ssh-config', 1],
      ['manual', 1]
    ])
  })

  it('clears the selection on Escape', async () => {
    const pane = await renderPane([host('alpha'), host('beta')])
    await act(async () => checkbox(pane, 'alpha').click())
    expect(pane.textContent).toContain('1 selected')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(pane.textContent).not.toContain('selected')
  })
})
