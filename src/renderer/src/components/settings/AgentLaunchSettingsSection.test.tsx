// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentPostPasteSubmitInput } from '../../../../shared/tui-agent-post-paste-submit'
import { AgentLaunchSettingsSection } from './AgentLaunchSettingsSection'
import type { SettingsHostScope } from './settings-host-scope'

type PostPasteSubmitInputSaver = (
  agent: TuiAgent,
  value: AgentPostPasteSubmitInput
) => Promise<void>

type CapturedLocalCatalogProps = {
  local?: {
    savePostPasteSubmitInput: PostPasteSubmitInputSaver
  }
}

type RemoteCatalogProps = {
  environmentId: string
  pairingRevision: number
}
type RemoteCatalogSpy = (props: RemoteCatalogProps) => void
type LocalCatalogSpy = (props: CapturedLocalCatalogProps) => void
type UpdateSettingsOrThrow = (
  updates: Partial<GlobalSettings>,
  onAcknowledged?: (next: GlobalSettings) => void
) => Promise<void>

type TestState = {
  runtimeEnvironments: { id: string; name: string; createdAt: number; pairingRevision: number }[]
  remote: Mock<RemoteCatalogSpy>
  local: Mock<LocalCatalogSpy>
  catalogProps: CapturedLocalCatalogProps | null
  settings: GlobalSettings | null
  updateSettingsOrThrow: Mock<UpdateSettingsOrThrow>
}

const state = vi.hoisted((): TestState => ({
  runtimeEnvironments: [{ id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 17 }],
  remote: vi.fn<RemoteCatalogSpy>(),
  local: vi.fn<LocalCatalogSpy>(),
  catalogProps: null,
  settings: null,
  updateSettingsOrThrow: vi.fn<UpdateSettingsOrThrow>()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (value: { runtimeEnvironments: typeof state.runtimeEnvironments }) => unknown) =>
      selector({ runtimeEnvironments: state.runtimeEnvironments }),
    {
      getState: () => ({
        settings: state.settings,
        updateSettingsOrThrow: state.updateSettingsOrThrow
      })
    }
  )
}))
vi.mock('./HostAgentLaunchSettings', async () => {
  const { useState } = await import('react')
  return {
    HostAgentLaunchSettings: (props: { environmentId: string; pairingRevision: number }) => {
      state.remote(props)
      // Stands in for unsaved edits: survives prop changes, dropped only by a remount.
      const [mountedAt] = useState(props.pairingRevision)
      return <p>Remote launch settings mounted at {mountedAt}</p>
    }
  }
})
vi.mock('./AgentLaunchSettingsCatalog', () => ({
  AgentLaunchSettingsLoading: () => <button disabled>Permissions</button>,
  AgentLaunchSettingsCatalog: (props: CapturedLocalCatalogProps) => {
    state.local(props)
    state.catalogProps = props
    return <p>Local launch settings</p>
  }
}))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.stubGlobal('api', {
    platform: { get: () => ({ platform: 'darwin' }) },
    settings: { get: () => Promise.resolve(state.settings) }
  })
  state.runtimeEnvironments = [
    { id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 17 }
  ]
  state.remote.mockClear()
  state.local.mockClear()
  state.catalogProps = null
  state.settings = null
  state.updateSettingsOrThrow.mockReset()
})
const SSH_HOST: SettingsHostScope = {
  target: { kind: 'environment', environmentId: 'ssh-host' },
  available: true
}
const section = (
  hostScope: SettingsHostScope,
  activeRuntimeEnvironmentId: string | null = null
) => (
  <AgentLaunchSettingsSection
    settings={createGlobalSettingsFixture({ activeRuntimeEnvironmentId })}
    updateSettings={vi.fn()}
    hostScope={hostScope}
    renderPermissions={() => null}
  />
)

describe('launch settings host', () => {
  it("edits the chosen server's launch settings even when the Active Server is this computer", () => {
    render(section(SSH_HOST))
    expect(screen.getByText('Remote launch settings mounted at 17')).toBeTruthy()
    expect(state.remote.mock.calls[0]?.[0]).toMatchObject({
      environmentId: 'ssh-host',
      pairingRevision: 17,
      hostName: 'SSH host'
    })
    expect(state.local).not.toHaveBeenCalled()
  })

  it('edits desktop launch settings when this computer is chosen over the Active Server', () => {
    render(section({ target: { kind: 'local' }, available: true }, 'ssh-host'))
    expect(screen.getByText('Local launch settings')).toBeTruthy()
    expect(state.remote).not.toHaveBeenCalled()
  })

  it('keeps earlier submit-key selections when several agents are updated before a rerender', async () => {
    const settings = createGlobalSettingsFixture({ agentPostPasteSubmitInputs: {} })
    state.settings = settings
    state.updateSettingsOrThrow.mockImplementation(
      async (updates: Partial<GlobalSettings>, onAcknowledged?: (next: GlobalSettings) => void) => {
        if (!state.settings) {
          throw new Error('Expected settings to be available before saving.')
        }
        state.settings = { ...state.settings, ...updates }
        onAcknowledged?.(state.settings)
      }
    )
    render(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={{ target: { kind: 'local' }, available: true }}
        renderPermissions={() => null}
      />
    )
    const savePostPasteSubmitInput = state.catalogProps?.local?.savePostPasteSubmitInput
    if (!savePostPasteSubmitInput) {
      throw new Error('Expected the local catalog to provide a post-paste submit-input saver.')
    }

    await Promise.all([
      savePostPasteSubmitInput('codex', 'ctrl-enter'),
      savePostPasteSubmitInput('claude', 'ctrl-enter')
    ])

    expect(state.settings?.agentPostPasteSubmitInputs).toEqual({
      codex: 'ctrl-enter',
      claude: 'ctrl-enter'
    })
  })

  it('keeps submit-key saves ordered across a host-scope remount', async () => {
    const settings = createGlobalSettingsFixture({ agentPostPasteSubmitInputs: {} })
    state.settings = settings
    let releaseFirstSave: () => void = () => {
      throw new Error('Expected the first settings write to be pending.')
    }
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve
    })
    state.updateSettingsOrThrow.mockImplementation(
      async (updates: Partial<GlobalSettings>, onAcknowledged?: (next: GlobalSettings) => void) => {
        if (state.updateSettingsOrThrow.mock.calls.length === 1) {
          await firstSaveGate
        }
        if (!state.settings) {
          throw new Error('Expected settings to be available before saving.')
        }
        state.settings = { ...state.settings, ...updates }
        onAcknowledged?.(state.settings)
      }
    )
    const { rerender } = render(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={{ target: { kind: 'local' }, available: true }}
        renderPermissions={() => null}
      />
    )
    const firstSave = state.catalogProps?.local?.savePostPasteSubmitInput
    if (!firstSave) {
      throw new Error('Expected the local catalog to provide a post-paste submit-input saver.')
    }
    const firstWrite = firstSave('codex', 'ctrl-enter')
    await waitFor(() => expect(state.updateSettingsOrThrow).toHaveBeenCalledTimes(1))

    rerender(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={SSH_HOST}
        renderPermissions={() => null}
      />
    )
    rerender(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={{ target: { kind: 'local' }, available: true }}
        renderPermissions={() => null}
      />
    )
    const secondSave = state.catalogProps?.local?.savePostPasteSubmitInput
    if (!secondSave) {
      throw new Error(
        'Expected the remounted local catalog to provide a post-paste submit-input saver.'
      )
    }
    const secondWrite = secondSave('claude', 'ctrl-enter')
    expect(state.updateSettingsOrThrow).toHaveBeenCalledTimes(1)

    releaseFirstSave()
    await Promise.all([firstWrite, secondWrite])

    expect(state.settings?.agentPostPasteSubmitInputs).toEqual({
      codex: 'ctrl-enter',
      claude: 'ctrl-enter'
    })
  })

  it('preserves queued submit-key selections when an earlier acknowledgement is fenced', async () => {
    const settings = createGlobalSettingsFixture({ agentPostPasteSubmitInputs: {} })
    const writes: Partial<GlobalSettings>[] = []
    let persistedSettings = settings
    state.settings = settings
    vi.stubGlobal('api', {
      platform: { get: () => ({ platform: 'darwin' }) },
      settings: { get: () => Promise.resolve(persistedSettings) }
    })
    state.updateSettingsOrThrow.mockImplementation(
      async (updates: Partial<GlobalSettings>, onAcknowledged?: (next: GlobalSettings) => void) => {
        writes.push(updates)
        persistedSettings = { ...persistedSettings, ...updates }
        onAcknowledged?.(persistedSettings)
      }
    )
    render(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={{ target: { kind: 'local' }, available: true }}
        renderPermissions={() => null}
      />
    )
    const savePostPasteSubmitInput = state.catalogProps?.local?.savePostPasteSubmitInput
    if (!savePostPasteSubmitInput) {
      throw new Error('Expected the local catalog to provide a post-paste submit-input saver.')
    }

    await Promise.all([
      savePostPasteSubmitInput('codex', 'ctrl-enter'),
      savePostPasteSubmitInput('claude', 'ctrl-enter')
    ])

    expect(writes.map((updates) => updates.agentPostPasteSubmitInputs)).toEqual([
      { codex: 'ctrl-enter' },
      { codex: 'ctrl-enter', claude: 'ctrl-enter' }
    ])
    expect(state.settings?.agentPostPasteSubmitInputs).toEqual({})
  })

  it('does not overwrite a newer submit-key selection from another window', async () => {
    const settings = createGlobalSettingsFixture({ agentPostPasteSubmitInputs: {} })
    const writes: Partial<GlobalSettings>[] = []
    let persistedSettings = settings
    state.settings = settings
    vi.stubGlobal('api', {
      platform: { get: () => ({ platform: 'darwin' }) },
      settings: { get: () => Promise.resolve(persistedSettings) }
    })
    state.updateSettingsOrThrow.mockImplementation(
      async (updates: Partial<GlobalSettings>, onAcknowledged?: (next: GlobalSettings) => void) => {
        writes.push(updates)
        persistedSettings = { ...persistedSettings, ...updates }
        onAcknowledged?.(persistedSettings)
      }
    )
    render(
      <AgentLaunchSettingsSection
        settings={settings}
        updateSettings={vi.fn()}
        hostScope={{ target: { kind: 'local' }, available: true }}
        renderPermissions={() => null}
      />
    )
    const savePostPasteSubmitInput = state.catalogProps?.local?.savePostPasteSubmitInput
    if (!savePostPasteSubmitInput) {
      throw new Error('Expected the local catalog to provide a post-paste submit-input saver.')
    }

    await savePostPasteSubmitInput('codex', 'ctrl-enter')
    persistedSettings = {
      ...persistedSettings,
      agentPostPasteSubmitInputs: {
        ...persistedSettings.agentPostPasteSubmitInputs,
        codex: 'enter'
      }
    }
    state.settings = persistedSettings
    await savePostPasteSubmitInput('claude', 'ctrl-enter')

    expect(writes.map((updates) => updates.agentPostPasteSubmitInputs)).toEqual([
      { codex: 'ctrl-enter' },
      { codex: 'enter', claude: 'ctrl-enter' }
    ])
  })

  it('remounts the host form when its host is re-paired, dropping unsaved edits', () => {
    const { rerender } = render(section(SSH_HOST))
    expect(screen.getByText('Remote launch settings mounted at 17')).toBeTruthy()
    state.runtimeEnvironments = [
      { id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 18 }
    ]
    rerender(section(SSH_HOST))
    expect(screen.getByText('Remote launch settings mounted at 18')).toBeTruthy()
  })

  it('waits for the server list instead of displaying desktop defaults', () => {
    state.runtimeEnvironments = []
    render(section(SSH_HOST))
    expect(screen.getByRole('button', { name: 'Permissions' })).toHaveProperty('disabled', true)
    expect(state.local).not.toHaveBeenCalled()
    expect(state.remote).not.toHaveBeenCalled()
  })

  it('says a removed server is unavailable instead of showing another host', () => {
    state.runtimeEnvironments = []
    render(section({ ...SSH_HOST, available: false }))
    expect(screen.getByText(/This server is no longer saved/)).toBeTruthy()
    expect(state.local).not.toHaveBeenCalled()
    expect(state.remote).not.toHaveBeenCalled()
  })
})
