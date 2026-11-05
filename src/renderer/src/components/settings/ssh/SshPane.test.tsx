// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetSshConfigPassiveSyncForTests } from '../../../lib/ssh-config-passive-sync'
import type { SshConnectionState, SshTarget } from '../../../../../shared/ssh-types'

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
vi.mock('@/store/index', () => {
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
vi.mock('./targets/SshTargetForm', () => ({ SshTargetForm: () => null }))
vi.mock('./targets/ssh-target-draft', () => ({ EMPTY_FORM: {} }))
vi.mock('./targets/SshTargetDestructiveActions', () => ({
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
vi.mock('./server-actions/SshTargetServerStatus', () => ({
  SshTargetServerStatusLine: () => null,
  SshTargetServerMenuItems: () => null,
  SshTargetServerDialogs: () => null
}))
// Radix menus open on pointer events happy-dom doesn't model; render items as plain buttons.
vi.mock('../../ui/dropdown-menu', () => {
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
vi.mock('./targets/SshTargetsEmptyState', () => ({ SshTargetsEmptyState: () => null }))

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

    // Explain when filtering deselects the last host instead of silently hiding the bulk bar.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(filter, 'c3')
      filter.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(pane.textContent).not.toContain('selected ')
    expect(pane.textContent).toContain('1 hidden host deselected')
  })
})
