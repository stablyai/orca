// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentUpdatesState } from '../../../../shared/agent-updates/agent-update-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AgentUpdateStatusSegment } from './AgentUpdateStatusSegment'

const owner = vi.hoisted(() => {
  const ref: { current: RuntimeClientTarget | null } = { current: { kind: 'local' } }
  return ref
})
vi.mock('./agent-update-owner', () => ({ useAgentUpdatesOwner: () => owner.current }))

const remote = vi.hoisted(() => ({
  supported: true,
  callRuntimeRpc: vi.fn()
}))
vi.mock('../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: remote.callRuntimeRpc
}))
vi.mock('../../runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => remote.supported
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div data-tooltip>{children}</div>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>
}))

const EMPTY: AgentUpdatesState = { rows: [], checking: false, checkedAt: null }
const TWO_UPDATES: AgentUpdatesState = {
  rows: [
    {
      agent: 'codex',
      current: '0.166.0',
      latest: '0.167.0',
      updateAvailable: true,
      action: { kind: 'run' },
      run: null
    },
    {
      agent: 'gemini',
      current: '0.49.0',
      latest: '0.67.0',
      updateAvailable: true,
      action: { kind: 'run' },
      run: null
    }
  ],
  checking: false,
  checkedAt: 1
}

const REMOTE_UPDATE: AgentUpdatesState = {
  rows: [
    {
      agent: 'claude',
      current: '2.1.0',
      latest: '2.2.0',
      updateAvailable: true,
      action: { kind: 'run' },
      run: null
    }
  ],
  checking: false,
  checkedAt: 2
}
const RUNNING_REMOTE_UPDATE: AgentUpdatesState = {
  ...REMOTE_UPDATE,
  rows: [{ ...REMOTE_UPDATE.rows[0], run: { state: 'running' } }]
}

let pushState: ((state: AgentUpdatesState) => void) | null = null
const agentUpdates = {
  getState: vi.fn(async () => EMPTY),
  refresh: vi.fn(async () => EMPTY),
  update: vi.fn(async () => {}),
  onState: vi.fn((callback: (state: AgentUpdatesState) => void) => {
    pushState = callback
    return () => {
      pushState = null
    }
  })
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function render(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await rerender()
}

async function rerender(): Promise<void> {
  await act(async () => {
    root?.render(<AgentUpdateStatusSegment iconOnly={false} />)
  })
}

async function push(state: AgentUpdatesState): Promise<void> {
  await act(async () => {
    pushState?.(state)
  })
}

function rowOf(versionChange: string): HTMLLIElement | undefined {
  return Array.from(container?.querySelectorAll('li') ?? []).find((row) =>
    row.textContent?.includes(versionChange)
  )
}

function updateAllButton(): HTMLButtonElement | undefined {
  // Trigger first, then the header's Update all; row buttons live inside <li>.
  return Array.from(container?.querySelectorAll('button') ?? []).filter(
    (button) => !button.closest('li')
  )[1]
}

describe('AgentUpdateStatusSegment', () => {
  beforeEach(() => {
    pushState = null
    owner.current = { kind: 'local' }
    remote.supported = true
    remote.callRuntimeRpc.mockReset()
    agentUpdates.refresh.mockReset()
    agentUpdates.refresh.mockResolvedValue(EMPTY)
    agentUpdates.update.mockClear()
    Object.defineProperty(window, 'api', { configurable: true, value: { agentUpdates } })
  })

  afterEach(async () => {
    await push(EMPTY)
    if (root) {
      await act(async () => root?.unmount())
    }
    root = null
    container?.remove()
    container = null
  })

  it('renders nothing when no agent needs attention', async () => {
    await render()
    expect(container?.innerHTML).toBe('')
  })

  it('shows the count and each version change', async () => {
    await render()
    await push(TWO_UPDATES)

    expect(container?.querySelector('button')?.textContent?.trim()).toBe('2')
    expect(container?.textContent).toContain('0.166.0 → 0.167.0')
    expect(container?.textContent).toContain('0.49.0 → 0.67.0')
  })

  it('updates every runnable agent from "Update all"', async () => {
    await render()
    await push(TWO_UPDATES)

    await act(async () => {
      updateAllButton()?.click()
    })

    expect(agentUpdates.update).toHaveBeenCalledTimes(1)
    expect(agentUpdates.update).toHaveBeenCalledWith({ agents: ['codex', 'gemini'] })
  })

  it('updates a single agent from its row', async () => {
    await render()
    await push(TWO_UPDATES)

    await act(async () => {
      rowOf('0.166.0 → 0.167.0')?.querySelector('button')?.click()
    })

    expect(agentUpdates.update).toHaveBeenCalledWith({ agents: ['codex'] })
  })

  it('disables every update button while any agent is updating', async () => {
    await render()
    await push({
      ...TWO_UPDATES,
      rows: [{ ...TWO_UPDATES.rows[0], run: { state: 'running' } }, TWO_UPDATES.rows[1]]
    })

    expect(updateAllButton()?.disabled).toBe(true)
    expect(rowOf('0.49.0 → 0.67.0')?.querySelector('button')?.disabled).toBe(true)
  })

  it("shows and updates a server workspace's agents through the server", async () => {
    const server: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }
    owner.current = server
    remote.callRuntimeRpc.mockImplementation(async (_target, method: string) =>
      method === 'agentUpdates.refresh' ? REMOTE_UPDATE : RUNNING_REMOTE_UPDATE
    )
    await render()

    expect(container?.textContent).toContain('2.1.0 → 2.2.0')
    expect(remote.callRuntimeRpc).toHaveBeenCalledWith(server, 'agentUpdates.refresh', undefined)
    expect(agentUpdates.refresh).not.toHaveBeenCalled()

    await act(async () => {
      updateAllButton()?.click()
    })

    expect(remote.callRuntimeRpc).toHaveBeenCalledWith(server, 'agentUpdates.update', {
      agents: ['claude']
    })
    expect(agentUpdates.update).not.toHaveBeenCalled()
    expect(updateAllButton()?.disabled).toBe(true)
  })

  it('renders nothing for a server that cannot report agent updates', async () => {
    owner.current = { kind: 'environment', environmentId: 'env-old' }
    remote.supported = false
    agentUpdates.refresh.mockResolvedValue(TWO_UPDATES)
    await render()

    expect(container?.innerHTML).toBe('')
    expect(remote.callRuntimeRpc).not.toHaveBeenCalled()
    expect(agentUpdates.refresh).not.toHaveBeenCalled()
  })

  it('renders nothing for a workspace whose machine it cannot reach', async () => {
    owner.current = null
    agentUpdates.refresh.mockResolvedValue(TWO_UPDATES)
    await render()

    expect(container?.innerHTML).toBe('')
    expect(agentUpdates.refresh).not.toHaveBeenCalled()
  })

  it("switches to this machine's agents when focus moves to a local workspace", async () => {
    owner.current = { kind: 'environment', environmentId: 'env-2' }
    remote.callRuntimeRpc.mockResolvedValue(REMOTE_UPDATE)
    agentUpdates.refresh.mockResolvedValue(TWO_UPDATES)
    await render()
    expect(container?.textContent).toContain('2.1.0 → 2.2.0')

    owner.current = { kind: 'local' }
    await rerender()

    expect(container?.textContent).toContain('0.166.0 → 0.167.0')
    expect(container?.textContent).not.toContain('2.1.0 → 2.2.0')
  })
})
