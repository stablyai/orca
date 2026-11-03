// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalLimitSetting } from './TerminalLimitSetting'
import { readTerminalLimit, saveTerminalLimit } from './terminal-limit-transport'
import type * as TerminalLimitTransport from './terminal-limit-transport'
import type { SettingsHostScope } from './settings-host-scope'
import type { TerminalLimitStatus } from '../../../../shared/terminal-limit-policy'
import { useAppStore } from '@/store'
import { i18n } from '@/i18n/i18n'
import ptCatalog from '@/i18n/locales/pt.json'
import { getTerminalAdvancedSearchEntries } from './terminal-advanced-platform-search'
import { matchesSettingsSearch } from './settings-search'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { callHostRoute } from '@/runtime/host-route-call'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'

vi.mock('@/runtime/host-route-call', () => ({ callHostRoute: vi.fn() }))
vi.mock('./terminal-limit-transport', () => ({
  readTerminalLimit: vi.fn(),
  saveTerminalLimit: vi.fn()
}))
const search = vi.hoisted(() => ({ query: '' }))
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))
vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  const { createRuntimeStatusTestStore } =
    await import('@/store/slices/runtime-status.test-fixture')
  const store = createRuntimeStatusTestStore()
  return {
    useAppStore: Object.assign(
      (select: (state: unknown) => unknown) =>
        useStore(store, (state) => select({ ...state, settingsSearchQuery: search.query })),
      store
    )
  }
})
vi.mock('@/store/host-catalog-fencing', () => ({
  captureHostIdentityFence: () => ({}),
  isHostIdentityFenceCurrent: () => true
}))
const transport = await vi.importActual<typeof TerminalLimitTransport>('./terminal-limit-transport')
const local: SettingsHostScope = { target: { kind: 'local' }, available: true }
const base: TerminalLimitStatus = {
  maxTerminals: 256,
  systemPtyLimit: 511,
  source: 'default',
  editable: true,
  daemonNonce: 'daemon-a'
}
let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  await i18n.changeLanguage('en')
  search.query = ''
  useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(readTerminalLimit).mockReset().mockResolvedValue(base)
  vi.mocked(saveTerminalLimit)
    .mockReset()
    .mockImplementation(async (_route, update) => ({
      ...base,
      maxTerminals: update.maxTerminals,
      source: 'saved'
    }))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})
async function render(scope = local): Promise<void> {
  await act(async () => root.render(<TerminalLimitSetting scope={scope} />))
}
function input(): HTMLInputElement {
  const found = container.querySelector('input')
  if (!found) {
    throw new Error('No terminal limit input')
  }
  return found
}
async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function enter(): Promise<void> {
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
}

it('clamps in the input, confirms Enter and blur saves once, and omits the caption and reset', async () => {
  await render()
  expect(input().value).toBe('256')
  expect(input().max).toBe('511')
  expect(container.textContent).toContain('System PTY limit: 511')
  expect(container.textContent).not.toMatch(/Reset|Default:|1–511|Couldn’t read/)
  await type('9999')
  expect(input().value).toBe('511')
  await enter()
  await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(saveTerminalLimit).toHaveBeenCalledTimes(1)
  expect(saveTerminalLimit).toHaveBeenLastCalledWith(
    { target: { kind: 'local' }, at: 'local' },
    { maxTerminals: 511, daemonNonce: 'daemon-a' },
    expect.any(AbortSignal)
  )
  await type('384')
  await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(input().value).toBe('384')
})

it('discards a late answer and draft when switching execution hosts', async () => {
  let complete: ((value: TerminalLimitStatus) => void) | undefined
  vi.mocked(readTerminalLimit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  await render()
  expect(input().disabled).toBe(true)
  expect(input().value).toBe('')
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 128,
    systemPtyLimit: 256,
    daemonNonce: 'daemon-b'
  })
  publish('server', true, 1)
  await render({ target: { kind: 'environment', environmentId: 'server' }, available: true })
  await act(async () => complete?.(base))
  expect(input().value).toBe('128')
  expect(input().max).toBe('256')
  advanceRuntimeEnvironmentConnectionGeneration('server')
  vi.mocked(readTerminalLimit).mockResolvedValue({ ...base, maxTerminals: 64 })
  await render({ target: { kind: 'environment', environmentId: 'server' }, available: true })
  expect(input().value).toBe('64')
})

it('retains a failed draft and ignores its late refresh after a successful retry', async () => {
  await render()
  let completeRefresh: ((value: TerminalLimitStatus) => void) | undefined
  vi.mocked(readTerminalLimit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeRefresh = resolve
      })
  )
  vi.mocked(saveTerminalLimit).mockRejectedValueOnce(new Error('disk unavailable'))
  await type('384')
  await enter()
  expect(input().value).toBe('384')
  expect(container.textContent).toContain('Couldn’t confirm')
  expect(container.textContent).not.toContain('saved')
  await type('400')
  await enter()
  await act(async () => completeRefresh?.(base))
  expect(input().value).toBe('400')
  expect(container.textContent).not.toContain('Couldn’t confirm')
})

it('keeps confirmed environment values above the bound and leaves old daemons uneditable', async () => {
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 600,
    source: 'environment',
    editable: false
  })
  await render()
  expect(input().value).toBe('600')
  expect(input().disabled).toBe(true)
  expect(container.textContent).toContain('environment')
  vi.mocked(readTerminalLimit).mockResolvedValue(null)
  publish('old', true, 1)
  await render({ target: { kind: 'environment', environmentId: 'old' }, available: true })
  expect(input().value).toBe('')
  expect(input().disabled).toBe(true)
  expect(container.textContent).toContain('does not support')
})

const runtime: RuntimeStatus = {
  runtimeId: 'same-runtime',
  rendererGraphEpoch: 0,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0
}
function publish(id: string, live: boolean, checkedAt: number): void {
  useAppStore.getState().setRuntimeEnvironmentStatus(id, {
    status: live ? runtime : null,
    checkedAt,
    snapshot: {
      environmentId: id,
      pairingRevision: 1,
      sequence: checkedAt,
      checkedAt,
      status: runtime,
      verification: live ? 'verified' : 'unavailable',
      transport: live ? 'ready' : 'disconnected'
    }
  })
}

it('disables on contact loss and reads again on a real same-runtime recovery publication', async () => {
  publish('server', true, 1)
  const scope: SettingsHostScope = {
    target: { kind: 'environment', environmentId: 'server' },
    available: true
  }
  await render(scope)
  await type('384')
  const generation = useAppStore
    .getState()
    .runtimeStatusByEnvironmentId.get('server')?.connectionGeneration
  await act(async () => publish('server', false, 2))
  expect(input().disabled).toBe(true)
  expect(input().value).toBe('')
  expect(container.textContent).toContain('disconnected')
  vi.mocked(readTerminalLimit).mockResolvedValue({ ...base, maxTerminals: 64 })
  await act(async () => publish('server', true, 3))
  expect(
    useAppStore.getState().runtimeStatusByEnvironmentId.get('server')?.connectionGeneration
  ).toBe(generation)
  expect(input().disabled).toBe(false)
  expect(input().value).toBe('64')
  expect(readTerminalLimit).toHaveBeenCalledTimes(2)
})

it('finds and formats capacity in the UI language in the catalog and rendered row', async () => {
  await i18n.changeLanguage('fr')
  search.query = 'capacité'
  expect(
    getTerminalAdvancedSearchEntries().some((entry) => matchesSettingsSearch(search.query, entry))
  ).toBe(true)
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 2048,
    systemPtyLimit: 4096,
    savedUnreadable: true
  })
  const format = vi.spyOn(Number.prototype, 'toLocaleString')
  try {
    await render()
    expect(input().value).toBe('2048')
    expect(container.textContent).toContain('4\u202f096')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('2\u202f048')
    expect(format).toHaveBeenCalledWith('fr')
    expect(format).not.toHaveBeenCalledWith()
    search.query = 'aucun-résultat'
    await render()
    expect(container.querySelector('input')).toBeNull()
    expect(ptCatalog.settings.terminal.limit.savedUnreadable).toContain('Não foi possível ler')
  } finally {
    format.mockRestore()
  }
})

it.each([
  ['Enter', 256],
  ['blur', 256],
  ['Enter', 384]
] as const)(
  'repairs an unreadable saved limit with %s at %s, including the edited effective value',
  async (event, maximum) => {
    vi.mocked(readTerminalLimit).mockResolvedValue({ ...base, savedUnreadable: true })
    await render()
    expect(input().disabled).toBe(false)
    expect(container.textContent).toContain('Using 256')
    await type('')
    await type(String(maximum))
    await (event === 'Enter'
      ? enter()
      : act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }))))
    expect(saveTerminalLimit).toHaveBeenCalledWith(
      expect.anything(),
      { maxTerminals: maximum, daemonNonce: 'daemon-a' },
      expect.any(AbortSignal)
    )
    expect(input().value).toBe(String(maximum))
    expect(container.textContent).not.toContain('Couldn’t read')
  }
)

it('uses the selected-host transport and refuses unsupported capability without issuing a policy RPC', async () => {
  const route = {
    target: { kind: 'environment' as const, environmentId: 'old-server' },
    at: 'local' as const
  }
  const signal = new AbortController().signal
  vi.mocked(callHostRoute).mockResolvedValue({ capabilities: [] })
  await expect(transport.readTerminalLimit(route, signal)).resolves.toBeNull()
  expect(callHostRoute).toHaveBeenCalledExactlyOnceWith(route, 'status.get', undefined, { signal })
})

it('preserves unhealthy above-bound readback on untouched and canceled commits', async () => {
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 384,
    systemPtyLimit: 128,
    source: 'saved',
    savedUnreadable: true
  })
  await render()
  const blur = async () =>
    act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  await enter()
  await blur()
  expect(input().value).toBe('384')
  expect(saveTerminalLimit).not.toHaveBeenCalled()
  await type('64')
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  )
  await blur()
  await enter()
  expect(input().value).toBe('384')
  expect(saveTerminalLimit).not.toHaveBeenCalled()
  await type('64')
  await blur()
  await enter()
  expect(input().value).toBe('64')
  expect(saveTerminalLimit).toHaveBeenCalledTimes(1)
})
