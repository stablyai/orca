// @vitest-environment happy-dom
import { render, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
const observation = vi.hoisted((): { current: ManagedRuntimeInstallObservation } => ({
  current: { kind: 'pending' }
}))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => observation.current
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['grok'],
  useHostStructuredAgentsVersion: () => 0
}))
vi.mock('./AntigravityChatSignInRow', () => ({ useAntigravityChatSignIn: () => ({ flow: null }) }))
import { useAppStore } from '@/store'
import { NativeChatProvidersSetting } from './NativeChatProvidersSetting'
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})
it('reserves the switch footprint through unknown and failed reads, then shows managed/external installed and saved false', () => {
  useAppStore.setState({ localDetectedAgentIdsByContext: { host: [] } })
  const settings = getDefaultSettings('/tmp')
  const surface = () => <NativeChatProvidersSetting settings={settings} updateSettings={vi.fn()} />
  const view = render(surface())
  expect(view.queryByRole('switch')).toBeNull()
  expect(view.container.querySelector('.h-5.w-9')).not.toBeNull()
  const active = {
    kind: 'active',
    subject: { target: { kind: 'local' }, runtimeId: null, agent: 'grok' },
    removable: false
  } as const
  observation.current = { ...active, snapshot: { kind: 'readFailed' } }
  view.rerender(surface())
  expect(view.queryByRole('switch')).toBeNull()
  const installed = {
    agent: 'grok',
    revision: 1,
    available: true,
    version: '1',
    installedVersion: '1',
    installedCurrent: true,
    operation: null
  } as const
  for (const source of ['managed', 'external'] as const) {
    observation.current = {
      ...active,
      snapshot: { kind: 'known', state: { ...installed, source } }
    }
    view.rerender(surface())
    expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('true')
    const icon = view.getByRole('switch').parentElement?.firstElementChild
    expect(icon?.classList.contains('size-7')).toBe(true)
  }
  settings.nativeChatProviders = { grok: false }
  view.rerender(surface())
  expect(view.getByRole('switch').getAttribute('aria-checked')).toBe('false')
})
