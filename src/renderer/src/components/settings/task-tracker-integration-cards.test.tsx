// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { LinearIntegrationCard } from './task-tracker-integration-cards'

type StoreState = {
  linearStatus: {
    connected: boolean
    workspaces?: { id: string; organizationName: string; displayName: string; email?: string }[]
  }
  linearStatusChecked: boolean
  linearStatusContextKey: string | null
  disconnectLinear: () => Promise<void>
  disconnectLinearWorkspace: () => Promise<void>
  checkLinearConnection: () => Promise<void>
  testLinearConnection: () => Promise<{ ok: boolean; error?: string }>
  settings: {
    activeRuntimeEnvironmentId: string | null
    localAgentRuntime?: 'host' | 'wsl'
    localAgentWslDistro?: string | null
    terminalWindowsShell?: string
    terminalWindowsWslDistro?: string | null
  }
}

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null },
  panelProps: [] as Record<string, unknown>[],
  skillRefresh: vi.fn(async () => {}),
  useInstalledAgentSkill: vi.fn(),
  ensureCli: vi.fn(async () => {}),
  ensureWslCli: vi.fn(async () => {})
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: mocks.useInstalledAgentSkill
}))

vi.mock('@/lib/agent-skill-cli-prerequisite', () => ({
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE: 'CLI registration notice',
  ensureOrcaCliAvailableForAgentSkillTerminal: mocks.ensureCli,
  isOrcaCliAvailableOnPath: (status: { state?: string; pathConfigured?: boolean } | null) =>
    status?.state === 'installed' && status.pathConfigured === true
}))

vi.mock('./CliSkillRuntimeSetup', () => ({
  buildSkillInstallCommandForRuntime: (
    command: string,
    runtime: { runtime: string; wslDistro?: string | null }
  ) =>
    runtime.runtime === 'wsl'
      ? `wsl.exe${runtime.wslDistro ? ` -d '${runtime.wslDistro}'` : ''} -- bash -lc '${command}'`
      : command,
  ensureWslCliAvailableForAgentSkillTerminal: mocks.ensureWslCli,
  getWslCliDistroRequest: (runtime?: { runtime: string; wslDistro?: string | null }) =>
    runtime?.runtime === 'wsl' && runtime.wslDistro?.trim()
      ? { distro: runtime.wslDistro.trim() }
      : undefined
}))

vi.mock('@/components/linear-api-key-dialog', () => ({
  LinearApiKeyDialog: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="simulate-linear-connected" onClick={onConnected}>
      Simulate Linear connected
    </button>
  )
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { actionHint?: ReactNode }) => {
    mocks.panelProps.push(props)
    return (
      <section data-testid="linear-skill-panel">
        <h2>{String(props.title)}</h2>
        <p>{String(props.description)}</p>
        <code>{String(props.command)}</code>
        <button type="button" onClick={() => void (props.onBeforeOpenTerminal as () => void)()}>
          Open installer
        </button>
        <button type="button" onClick={() => void (props.onRecheck as () => void)()}>
          Panel re-check
        </button>
        {props.actionHint}
      </section>
    )
  }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
const defaultUserAgent = navigator.userAgent

function installStore(
  connected: boolean,
  settings: StoreState['settings'] = { activeRuntimeEnvironmentId: null }
): void {
  mocks.store.current = {
    linearStatus: {
      connected,
      workspaces: connected
        ? [
            {
              id: 'workspace-1',
              organizationName: 'Acme',
              displayName: 'Acme workspace',
              email: 'linear@example.test'
            }
          ]
        : []
    },
    linearStatusChecked: true,
    linearStatusContextKey: getProviderRuntimeContextKey(settings),
    disconnectLinear: vi.fn(async () => {}),
    disconnectLinearWorkspace: vi.fn(async () => {}),
    checkLinearConnection: vi.fn(async () => {}),
    testLinearConnection: vi.fn(async () => ({ ok: true })),
    settings
  }
}

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<LinearIntegrationCard />)
  })
  return container
}

describe('LinearIntegrationCard skill setup', () => {
  beforeEach(() => {
    mocks.panelProps.length = 0
    mocks.skillRefresh.mockClear()
    mocks.ensureCli.mockClear()
    mocks.ensureWslCli.mockClear()
    mocks.useInstalledAgentSkill.mockReset()
    mocks.useInstalledAgentSkill.mockReturnValue({
      installed: false,
      loading: false,
      error: null,
      refresh: mocks.skillRefresh
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getWslInstallStatus: vi.fn(async () => undefined)
        }
      }
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    mocks.store.current = null
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: defaultUserAgent
    })
    Reflect.deleteProperty(window, 'api')
  })

  it('keeps Linear skill setup out of the disconnected state', async () => {
    installStore(false)

    const rendered = await renderCard()

    expect(rendered.querySelector('[data-testid="linear-skill-panel"]')).toBeNull()
    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({ enabled: false, sourceKinds: ['home'] })
    )
  })

  it('renders connected Linear skill setup with installer wiring', async () => {
    installStore(true)

    const rendered = await renderCard()

    expect(rendered.textContent).toContain('Linear agent skill')
    expect(rendered.textContent).toContain('linear-tickets')
    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({ enabled: true, sourceKinds: ['home'] })
    )

    const openInstallerButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open installer'
    )
    await act(async () => {
      openInstallerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.ensureCli).toHaveBeenCalledTimes(1)
  })

  it('uses the WSL skill location for connected Linear setup when selected', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Windows'
    })
    installStore(true, {
      activeRuntimeEnvironmentId: null,
      localAgentRuntime: 'wsl',
      localAgentWslDistro: 'Fedora',
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Ubuntu'
    })

    const rendered = await renderCard()

    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Fedora' },
        enabled: true,
        sourceKinds: ['home']
      })
    )
    expect(rendered.textContent).toContain("wsl.exe -d 'Fedora' -- bash -lc 'npx skills add")
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        terminalShellOverride: 'powershell.exe',
        getPrerequisiteStatus: expect.any(Function)
      })
    )
    const getPrerequisiteStatus = mocks.panelProps.at(-1)?.getPrerequisiteStatus
    expect(getPrerequisiteStatus).toEqual(expect.any(Function))
    await expect((getPrerequisiteStatus as () => Promise<unknown>)()).resolves.toBeUndefined()
    expect(window.api.cli.getWslInstallStatus).toHaveBeenCalledWith({ distro: 'Fedora' })

    const openInstallerButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open installer'
    )
    await act(async () => {
      openInstallerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.ensureWslCli).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'wsl', wslDistro: 'Fedora' })
    )
    expect(mocks.ensureCli).not.toHaveBeenCalled()
  })

  it('shows and dismisses the optional post-connect setup note', async () => {
    installStore(true)
    const rendered = await renderCard()

    expect(rendered.textContent).not.toContain('Optional next step')

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('[data-testid="simulate-linear-connected"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(rendered.textContent).toContain('Optional next step')

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Dismiss optional Linear agent skill setup note"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(rendered.textContent).not.toContain('Optional next step')
  })
})
