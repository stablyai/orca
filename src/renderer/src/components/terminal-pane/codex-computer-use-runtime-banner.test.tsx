// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planAgentSessionRestarts } from '@/lib/agent-session-restart-plan'
import type {
  AgentSessionRestartPlan,
  AgentSessionRestartTarget
} from '@/lib/agent-session-restart-plan'
import type { CodexComputerUseRuntimeStatus } from '../../../../shared/codex-computer-use-runtime'
import { noticeTestStore } from './codex-notice-test-harness'
import { CodexComputerUseRuntimeBanner } from './CodexComputerUseRuntimeBanner'

const mocks = vi.hoisted(() => ({
  request: vi.fn(() => Promise.resolve()),
  plan: vi.fn<() => AgentSessionRestartPlan>(),
  snapshot: { outcomes: [], running: false },
  inspect: vi.fn<(id: string) => Promise<CodexComputerUseRuntimeStatus>>()
}))
vi.mock('@/store', () => import('./codex-notice-test-harness'))
vi.mock('@/lib/agent-session-restart-service', () => ({
  collectAgentSessionRestartPlanFromState: mocks.plan,
  getAgentSessionRestartController: () => ({
    request: mocks.request,
    subscribe: () => () => {},
    getSnapshot: () => mocks.snapshot
  })
}))
vi.mock('../settings/AgentSessionRestartCommandDialog', () => ({
  AgentSessionRestartCommandDialog: () => <div data-testid="explicit-command">Explicit command</div>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let element: HTMLDivElement
let ptyId: string
let sequence = 0

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  ptyId = `cua-${++sequence}`
  noticeTestStore.setState(
    {
      agentStatusByPaneKey: {},
      paneForegroundAgentByPaneKey: {
        'tab:11111111-1111-4111-8111-111111111111': { agent: 'codex' }
      },
      agentLaunchConfigByPaneKey: {}
    },
    true
  )
  mocks.plan.mockReturnValue(
    planAgentSessionRestarts({
      enabledCatalog: ['codex'],
      panes: [
        {
          ptyId,
          tabId: 'tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          worktreeId: 'repo',
          workspaceLabel: 'repo',
          tabGeneration: 0,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session' },
          state: 'working',
          structuredHostOwned: false,
          executionHostId: 'local',
          foreignPty: false,
          wsl: false
        }
      ]
    })
  )
  mocks.inspect.mockResolvedValue({ status: 'stale' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { inspectCodexComputerUseRuntime: mocks.inspect } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  element.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function render(visible = true): Promise<void> {
  await act(async () =>
    root.render(
      <CodexComputerUseRuntimeBanner
        ptyId={ptyId}
        tabId="tab"
        leafId="11111111-1111-4111-8111-111111111111"
        isVisible={visible}
      />
    )
  )
}

describe('Codex Computer Use runtime recovery', () => {
  it('only submits the affected pane after the user requests recovery', async () => {
    await render()
    expect(element.textContent).toContain('older app runtime')
    expect(mocks.request).not.toHaveBeenCalled()
    const button = Array.from(element.querySelectorAll('button')).find(
      (entry) => entry.textContent === 'Restart this Codex'
    )
    expect(button).toBeDefined()
    await act(async () => button?.click())
    expect(mocks.request).toHaveBeenCalledWith('codex', [ptyId])
  })

  it('does not scan hidden panes and rechecks visible panes after an app update', async () => {
    await render(false)
    expect(mocks.inspect).not.toHaveBeenCalled()
    await render()
    expect(mocks.inspect).toHaveBeenCalledTimes(1)
    mocks.inspect.mockResolvedValue({ status: 'current' })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(element.textContent).not.toContain('older app runtime')
    await render(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(mocks.inspect).toHaveBeenCalledTimes(2)
  })

  it('keeps unsupported or missing inspection APIs quiet', async () => {
    mocks.inspect.mockResolvedValue({ status: 'unsupported' })
    await render()
    expect(element.textContent).toBe('')
    Object.defineProperty(window, 'api', { configurable: true, value: { pty: {} } })
    await render(false)
    await render()
    expect(element.textContent).toBe('')
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('reuses the explicit-command dialog when exact resume metadata is absent', async () => {
    const plan = mocks.plan()
    mocks.plan.mockReturnValue({
      ...plan,
      targets: plan.targets.map((target): AgentSessionRestartTarget => ({
        ...target,
        kind: 'skipped',
        reason: 'unknown-launch'
      }))
    })
    await render()
    expect(element.textContent).toContain('explicit resume command')
    const button = Array.from(element.querySelectorAll('button')).find(
      (entry) => entry.textContent === 'Restart with command…'
    )
    await act(async () => button?.click())
    expect(element.querySelector('[data-testid="explicit-command"]')).not.toBeNull()
    expect(mocks.request).not.toHaveBeenCalled()
    mocks.inspect.mockResolvedValue({ status: 'current' })
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(element.querySelector('[data-testid="explicit-command"]')).not.toBeNull()
  })
})
