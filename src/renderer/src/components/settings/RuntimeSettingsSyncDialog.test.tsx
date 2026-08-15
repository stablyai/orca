// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createPortableSettingsBundle } from '../../../../shared/portable-settings'
import { AGENTS_CLI_INSTALL_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { RuntimeSettingsSyncDialog } from './RuntimeSettingsSyncDialog'

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  configure: vi.fn(),
  stop: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ensureDetectedAgents: vi.fn(),
  ensureRuntimeDetectedAgents: vi.fn(),
  clearRuntimeDetectedAgents: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>): string =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))
vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      ensureDetectedAgents: typeof mocks.ensureDetectedAgents
      ensureRuntimeDetectedAgents: typeof mocks.ensureRuntimeDetectedAgents
      clearRuntimeDetectedAgents: typeof mocks.clearRuntimeDetectedAgents
    }) => unknown
  ) =>
    selector({
      ensureDetectedAgents: mocks.ensureDetectedAgents,
      ensureRuntimeDetectedAgents: mocks.ensureRuntimeDetectedAgents,
      clearRuntimeDetectedAgents: mocks.clearRuntimeDetectedAgents
    })
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude', cmd: 'claude', homepageUrl: 'https://example.com/claude' },
    { id: 'codex', label: 'Codex', cmd: 'codex', homepageUrl: 'https://example.com/codex' },
    { id: 'hermes', label: 'Hermes', cmd: 'hermes', homepageUrl: 'https://example.com/hermes' }
  ]
}))

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      keybindings: {
        get: vi.fn().mockResolvedValue({
          platform: 'linux',
          overrides: {},
          path: '/home/local/.orca/keybindings.json',
          exists: true,
          commonOverrides: {},
          platformOverrides: {},
          diagnostics: []
        })
      },
      portableSettingsSync: {
        configure: mocks.configure,
        stop: mocks.stop
      }
    }
  })
}

async function renderDialog(options?: {
  capabilities?: string[]
  hostPlatform?: NodeJS.Platform | null
}): Promise<{
  root: ReturnType<typeof createRoot>
  onClose: ReturnType<typeof vi.fn>
}> {
  const remoteBundle = createPortableSettingsBundle(getDefaultSettings('/home/remote'), {
    platform: 'linux',
    overrides: {}
  })
  mocks.callRuntimeRpc.mockResolvedValueOnce({ bundle: remoteBundle })
  mocks.ensureDetectedAgents.mockResolvedValue(['claude', 'codex', 'hermes'])
  mocks.ensureRuntimeDetectedAgents.mockResolvedValue(['codex'])
  installApi()
  const onClose = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <RuntimeSettingsSyncDialog
        environmentId="server-1"
        environmentName="Build server"
        settings={{ ...getDefaultSettings('/home/local'), theme: 'dark' }}
        syncState={null}
        hostPlatform={options?.hostPlatform ?? 'linux'}
        capabilities={options?.capabilities ?? [AGENTS_CLI_INSTALL_RUNTIME_CAPABILITY]}
        onClose={onClose}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  return { root, onClose }
}

describe('RuntimeSettingsSyncDialog', () => {
  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('previews safe category differences and performs a one-time sync', async () => {
    const remoteBundle = createPortableSettingsBundle(getDefaultSettings('/home/remote'), {
      platform: 'linux',
      overrides: {}
    })
    const { root, onClose } = await renderDialog({ capabilities: [] })
    mocks.callRuntimeRpc.mockResolvedValueOnce({
      bundle: remoteBundle,
      appliedCategories: ['appearance', 'input', 'workflow']
    })

    expect(document.body.textContent).toContain('Sync settings to Build server')
    expect(document.body.textContent).toContain('Accounts, credentials, secrets')
    expect(document.body.textContent).toContain('1 change')
    expect(document.body.textContent).not.toContain('Also install missing agent CLIs')
    const syncButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Sync now')
    )

    await act(async () => {
      syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'settings.portable.apply',
      {
        categories: ['appearance', 'input', 'workflow'],
        bundle: expect.objectContaining({ version: 1 })
      },
      { timeoutMs: 15_000 }
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Synced settings to Build server.')
    expect(onClose).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('offers missing agent CLI install when the server advertises the capability', async () => {
    const { root } = await renderDialog()
    expect(document.body.textContent).toContain('Also install missing agent CLIs')
    expect(document.body.textContent).toContain('Claude')
    expect(document.body.textContent).toContain('Also missing (install manually): Hermes')
    root.unmount()
  })

  it('installs selected missing agents after a one-time settings sync', async () => {
    const remoteBundle = createPortableSettingsBundle(getDefaultSettings('/home/remote'), {
      platform: 'linux',
      overrides: {}
    })
    const { root, onClose } = await renderDialog()
    mocks.callRuntimeRpc
      .mockResolvedValueOnce({
        bundle: remoteBundle,
        appliedCategories: ['appearance', 'input', 'workflow']
      })
      .mockResolvedValueOnce({
        results: [{ agent: 'claude', status: 'installed' }]
      })

    const syncButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Sync now')
    )
    await act(async () => {
      syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'agents.installCli',
      { agents: ['claude'] },
      { timeoutMs: 30 * 60 * 1000 }
    )
    expect(mocks.clearRuntimeDetectedAgents).toHaveBeenCalledWith('server-1')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Installed 1 agent CLI(s) on Build server.')
    expect(onClose).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('can make the selected categories continuously sync without installing agents', async () => {
    mocks.configure.mockResolvedValue({ phase: 'synced' })
    const { root, onClose } = await renderDialog({ capabilities: [] })
    const keepInSync = document.body.querySelector('[role="switch"]')

    await act(async () => {
      keepInSync?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const startButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Start syncing')
    )
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.configure).toHaveBeenCalledWith({
      environmentId: 'server-1',
      categories: ['appearance', 'input', 'workflow'],
      enabled: true
    })
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Settings will stay synced to Build server.')
    expect(onClose).toHaveBeenCalledOnce()
    root.unmount()
  })
})
