// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { ManageInstalledSkillsButton } from './ManageInstalledSkillsButton'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const runtime = vi.hoisted(() => ({
  manager: ((): RuntimeClientTarget | null => ({ kind: 'local' }))(),
  target: ((): BundledSkillTarget | null => ({ kind: 'local' }))()
}))
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: runtime.target,
    managerRuntimeTarget: runtime.manager
  })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
const originalStatuses = useAppStore.getState().runtimeStatusByEnvironmentId
const originalOpen = useAppStore.getState().openSkillsPage
const open = vi.fn()

beforeEach(() => {
  runtime.target = { kind: 'local' }
  runtime.manager = { kind: 'local' }
  open.mockClear()
  useAppStore.setState({ openSkillsPage: open, runtimeStatusByEnvironmentId: new Map() })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  useAppStore.setState({
    openSkillsPage: originalOpen,
    runtimeStatusByEnvironmentId: originalStatuses
  })
})

async function render(target?: BundledSkillTarget | null): Promise<void> {
  await act(async () => root?.render(<ManageInstalledSkillsButton target={target} />))
}

describe('installed skill management navigation', () => {
  it.each([{ kind: 'local' }, { kind: 'environment', environmentId: 'server' }] as const)(
    'opens the existing skill manager for the active $kind host',
    async (target) => {
      runtime.target = target
      runtime.manager = target
      await render(target)
      const button = container?.querySelector('button')
      expect(button).not.toBeNull()
      await act(async () => button?.click())
      expect(open).toHaveBeenCalledOnce()
    }
  )

  it('does not route a different or unresolved host to the active host manager', async () => {
    await render({ kind: 'environment', environmentId: 'other' })
    expect(container?.querySelector('button')).toBeNull()
    runtime.target = null
    await render()
    expect(container?.querySelector('button')).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
  it('keeps a remote card out of the local fallback inventory', async () => {
    runtime.target = { kind: 'environment', environmentId: 'server' }
    runtime.manager = { kind: 'local' }
    await render(runtime.target)
    expect(container?.querySelector('button')).toBeNull()
    runtime.manager = null
    await render(runtime.target)
    expect(container?.querySelector('button')).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
  it.each(['disconnected', 'retired', 'blocked'] as const)(
    'hides a cached installed host after it becomes %s',
    async (availability) => {
      runtime.target = { kind: 'environment', environmentId: 'server' }
      runtime.manager = runtime.target
      await render(runtime.target)
      expect(container?.querySelector('button')).not.toBeNull()
      await act(async () => {
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map([
            [
              'server',
              {
                status: null,
                checkedAt: 1,
                snapshot: {
                  environmentId: 'server',
                  pairingRevision: 1,
                  sequence: 2,
                  checkedAt: 1,
                  status: null,
                  verification: 'blocked',
                  transport: availability === 'disconnected' ? 'disconnected' : 'ready',
                  ...(availability === 'retired' ? { retired: true as const } : {})
                }
              }
            ]
          ])
        })
      })
      expect(container?.querySelector('button')).toBeNull()
      expect(open).not.toHaveBeenCalled()
    }
  )
})
