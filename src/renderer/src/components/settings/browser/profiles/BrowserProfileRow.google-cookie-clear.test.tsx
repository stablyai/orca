import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { ConfirmationDialogContext } from '../../../confirmation-dialog-context'
import {
  createTestStore,
  createBrowserMockApi
} from '@/store/slices/browser/browser-slice-test-harness'
import { getDefaultBrowserProfileForHost } from '@/store/slices/browser/hosts/browser-host-state'
import type { AppState } from '@/store/types'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import type { GoogleCookieClearLocalTarget } from '../../../../../../shared/browser-google-cookie-clear'
import { i18n } from '@/i18n/i18n'

let store: ReturnType<typeof createTestStore>
const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  confirm: vi.fn(),
  target: vi.fn(),
  clear: vi.fn()
}))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      (selector: (state: AppState) => unknown) => useStore(store, selector),
      { getState: () => store.getState() }
    )
  }
})
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: mocks.error, warning: vi.fn() }
}))
vi.mock('../../../BrowserCookieImportMachineNotice', () => ({
  BrowserCookieImportMachineNotice: () => null
}))
import { BrowserSessionCookiesSection } from './BrowserSessionCookiesSection'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

const profile = {
  id: 'default',
  label: 'Default',
  partition: 'persist:A',
  scope: 'default',
  source: null
} as const
const browser = {
  family: 'chrome',
  label: 'Google Chrome',
  profiles: [{ name: 'Default', directory: 'Default' }],
  selectedProfile: 'Default'
}
const local: GoogleCookieClearLocalTarget = {
  profileId: 'default',
  partition: 'persist:B',
  environmentId: null,
  routeIdentity: null
}
const environment = publicRuntimeEnvironment({
  id: 'server',
  name: 'Server',
  runtimeId: 'cached-A',
  pairingRevision: 7
})

let api: ReturnType<typeof createBrowserMockApi>
const profileEvents = new Set<() => void>()
function selectServer(capable = true) {
  replaceRuntimeEnvironmentRevisions([environment])
  const status = createCompatibleRuntimeStatusResponse().result
  store.setState({
    browserSessionHostIdOverride: 'runtime:server',
    runtimeEnvironments: [environment],
    runtimeStatusByEnvironmentId: new Map([
      [
        'server',
        { checkedAt: 1, status: { ...status, capabilities: capable ? status.capabilities : [] } }
      ]
    ])
  })
  return status
}
function SessionSection() {
  const hostId = useStore(store, (s) => s.browserSessionHostIdOverride ?? 'local')
  const profiles = useStore(store, (s) => s.browserSessionProfiles)
  const activeProfileId =
    useStore(store, (s) => getDefaultBrowserProfileForHost(s, hostId)) ?? 'default'
  return (
    <BrowserSessionCookiesSection
      selectedHostId={hostId}
      activeProfileId={activeProfileId}
      defaultProfile={profiles.find((p) => p.id === 'default')}
      nonDefaultProfiles={profiles.filter((p) => p.id !== 'default')}
      detectedBrowsers={[browser]}
      importState={null}
      hostOptions={[
        { id: 'local', label: 'This computer', detail: 'Local profiles' },
        { id: 'runtime:server', label: 'Server', detail: 'Remote profiles' }
      ]}
      onAddProfile={() => {}}
      onSelectHost={(host) => void store.getState().setBrowserSessionHostId(host)}
      onSelectDefaultProfile={() => store.getState().setDefaultBrowserSessionProfileId(null)}
      onSelectProfile={store.getState().setDefaultBrowserSessionProfileId}
    />
  )
}
function mount(node: ReactNode) {
  return render(
    <ConfirmationDialogContext.Provider value={mocks.confirm}>
      {node}
    </ConfirmationDialogContext.Provider>
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  profileEvents.clear()
  store = createTestStore()
  api = createBrowserMockApi(vi.fn())
  mocks.target.mockImplementation(async ({ profileId, environmentId }) => ({
    ...local,
    profileId,
    environmentId,
    partition: `persist:${profileId}`
  }))
  mocks.clear.mockResolvedValue('cleared')
  mocks.confirm.mockResolvedValue(true)
  api.browser.sessionListProfiles.mockResolvedValue([])
  Object.assign(api.browser, {
    onSessionProfilesChanged: (callback: () => void) => {
      profileEvents.add(callback)
      return () => {
        profileEvents.delete(callback)
      }
    },
    sessionGoogleCookieClearTarget: mocks.target,
    getPageSiteDisplay: vi.fn(async () => null),
    sessionClearGoogleCookies: mocks.clear
  })
  Object.assign(window, { api })
  store.setState({
    settingsSearchQuery: '',
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    browserSessionProfiles: [
      profile,
      { ...profile, id: 'private', scope: 'isolated', label: 'Private' }
    ],
    persistedUIReady: true,
    browserImportHintHidden: false,
    detectedBrowsers: [browser],
    detectedBrowsersLoaded: true,
    fetchDetectedBrowsers: vi.fn(async () => {})
  })
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCacheForTests()
})

it('captures the selected Host and Active profile at press through delayed capture/confirmation, cancel and repeat', async () => {
  selectServer()
  store.setState((s) => ({
    settings: { ...s.settings!, browserDefaultProfileIdByHostId: { 'runtime:server': 'private' } }
  }))
  mount(<SessionSection />)
  const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  const captured = Promise.withResolvers<typeof local>()
  mocks.target.mockReturnValueOnce(captured.promise)
  const confirmation = Promise.withResolvers<boolean>()
  mocks.confirm.mockReturnValueOnce(confirmation.promise)
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.target).toHaveBeenLastCalledWith({ profileId: 'private', environmentId: 'server' })
  await act(async () => {
    store.setState({ browserSessionHostIdOverride: 'local' })
    captured.resolve({
      ...local,
      profileId: 'private',
      environmentId: 'server',
      partition: 'persist:private'
    })
  })
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  expect(mocks.clear).not.toHaveBeenCalled()
  await act(async () => confirmation.resolve(true))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'private', environmentId: 'server' })
  )
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  mocks.confirm.mockResolvedValueOnce(false)
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenCalledTimes(1)
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'default', environmentId: null })
  )
  await act(async () => fireEvent.click(button))
  expect(mocks.clear).toHaveBeenCalledTimes(3)
})

it.each([false, true])(
  'refuses R7 replacement during initial local reply (null=%s), then permits fresh R8',
  async (absent) => {
    selectServer()
    const view = mount(<SessionSection />)
    const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    const reply = Promise.withResolvers<typeof local | null>()
    mocks.target.mockReturnValueOnce(reply.promise)
    fireEvent.click(button)
    replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 8 }])
    await act(async () => {
      store.setState({ runtimeEnvironments: [{ ...environment, pairingRevision: 8 }] })
      reply.resolve(absent ? null : { ...local, environmentId: 'server' })
    })
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(api.runtimeEnvironments.call).not.toHaveBeenCalled()
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    await act(async () => fireEvent.click(button))
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    mocks.confirm.mockClear()
    const consent = Promise.withResolvers<boolean>()
    mocks.confirm.mockReturnValueOnce(consent.promise)
    fireEvent.click(button)
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    replaceRuntimeEnvironmentRevisions([{ ...environment, pairingRevision: 9 }])
    await act(async () => consent.resolve(true))
    expect(mocks.clear).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledTimes(2)
    view.unmount()
  }
)

it.each(['success', 'rejection'])(
  'abandons pre-dialog %s after unmount, but a remounted open confirmation survives',
  async (outcome) => {
    const view = mount(
      <StrictMode>
        <SessionSection />
      </StrictMode>
    )
    const button = screen.getByRole('button', { name: 'Clear Google cookies…' })
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
    const reply = Promise.withResolvers<typeof local>()
    mocks.target.mockReturnValueOnce(reply.promise)
    fireEvent.click(button)
    view.unmount()
    await act(async () => {
      if (outcome === 'success') {
        reply.resolve(local)
      } else {
        reply.reject(new Error('late'))
      }
    })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.clear).not.toHaveBeenCalled()
    expect(profileEvents.size).toBe(0)
    const remounted = mount(<SessionSection />)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Clear Google cookies…' }).hasAttribute('disabled')
      ).toBe(false)
    )
    const consent = Promise.withResolvers<boolean>()
    mocks.confirm.mockReturnValueOnce(consent.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Clear Google cookies…' }))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
    remounted.unmount()
    await act(async () => consent.resolve(true))
    expect(mocks.clear).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'default', environmentId: null })
    )
  }
)
