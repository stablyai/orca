// @vitest-environment happy-dom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'
import { getFeatureSetupNpxPreflightContext } from './feature-setup-npx-preflight'
import { DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION } from './onboarding-feature-setup'

const INSTALL_COMMAND = 'npx skills add https://github.com/stablyai/orca --skill orca-cli --global'
const RUN_DESCRIPTION =
  'Press Enter to run the command and confirm npx if asked. You can also set this up later in Settings.'

const mocks = vi.hoisted(() => ({
  terminalProps: [] as { command: string; description: string }[],
  settings: {} as {
    activeRuntimeEnvironmentId?: string | null
    terminalWindowsShell?: string
    terminalWindowsWslDistro?: string | null
  },
  platform: 'darwin' as NodeJS.Platform,
  isNpxOnPath: vi.fn(),
  openUrl: vi.fn()
}))

vi.mock('./OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: { command: string; description: string }) => {
    mocks.terminalProps.push(props)
    return <div data-testid="inline-command-terminal">{props.description}</div>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: mocks.settings })
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn()
}))

let container: HTMLElement | null = null
let root: Root | null = null

async function renderTerminal({ strict = false }: { strict?: boolean } = {}): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await rerenderTerminal({ strict })
}

async function rerenderTerminal({ strict = false }: { strict?: boolean } = {}): Promise<void> {
  const terminal = (
    <FeatureSetupInlineTerminal
      command={INSTALL_COMMAND}
      selection={DEFAULT_ONBOARDING_FEATURE_SETUP_SELECTION}
    />
  )
  await act(async () => {
    root?.render(strict ? <StrictMode>{terminal}</StrictMode> : terminal)
  })
  await act(async () => {})
}

describe('FeatureSetupInlineTerminal', () => {
  beforeEach(() => {
    mocks.terminalProps.length = 0
    mocks.settings = {}
    mocks.platform = 'darwin'
    mocks.isNpxOnPath.mockReset()
    mocks.isNpxOnPath.mockResolvedValue(true)
    mocks.openUrl.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: mocks.platform }) },
        shell: { openUrl: mocks.openUrl },
        skills: { isNpxOnPath: mocks.isNpxOnPath }
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
    Reflect.deleteProperty(window, 'api')
  })

  it('keeps the run instruction when npx is on PATH', async () => {
    await renderTerminal()

    expect(mocks.isNpxOnPath).toHaveBeenCalledTimes(1)
    expect(mocks.isNpxOnPath).toHaveBeenCalledWith(undefined, { forceRefresh: false })
    expect(mocks.terminalProps.at(-1)?.description).toBe(RUN_DESCRIPTION)
  })

  it('issues one WSL preflight during a StrictMode mount', async () => {
    mocks.platform = 'win32'
    mocks.settings = {
      terminalWindowsShell: 'wsl.exe',
      terminalWindowsWslDistro: 'Ubuntu'
    }

    await renderTerminal({ strict: true })

    expect(mocks.isNpxOnPath).toHaveBeenCalledTimes(1)
    expect(mocks.isNpxOnPath).toHaveBeenCalledWith({ wslDistro: 'Ubuntu' }, { forceRefresh: false })
  })

  it('blocks the raw command and shows actionable guidance when npx is missing', async () => {
    mocks.isNpxOnPath.mockResolvedValue(false)

    await renderTerminal()

    expect(container?.textContent).toContain('Node.js is required')
    expect(container?.textContent).toContain('npx was not found in this terminal environment')
    expect(container?.textContent).toContain('Download Node.js')
    expect(container?.textContent).toContain('Re-check')
    expect(mocks.terminalProps).toHaveLength(0)
  })

  it('skips the local probe when a remote runtime environment is focused', async () => {
    mocks.settings = { activeRuntimeEnvironmentId: 'ssh-host-1' }
    mocks.isNpxOnPath.mockResolvedValue(false)

    await renderTerminal()

    expect(mocks.isNpxOnPath).not.toHaveBeenCalled()
    expect(mocks.terminalProps.at(-1)?.description).toBe(RUN_DESCRIPTION)
  })

  it('re-probes the host after switching back from a remote runtime', async () => {
    mocks.isNpxOnPath.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await renderTerminal()

    mocks.settings = { activeRuntimeEnvironmentId: 'ssh-host-1' }
    await rerenderTerminal()
    mocks.settings = {}
    await rerenderTerminal()

    expect(mocks.isNpxOnPath).toHaveBeenCalledTimes(2)
    expect(mocks.terminalProps.at(-1)?.description).toBe(RUN_DESCRIPTION)
  })

  it('ignores a stale local result after remote focus cancels the probe', async () => {
    let finishProbe: ((onPath: boolean) => void) | undefined
    mocks.isNpxOnPath.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = resolve
        })
    )
    await renderTerminal()

    mocks.settings = { activeRuntimeEnvironmentId: 'ssh-host-1' }
    await rerenderTerminal()
    await act(async () => {
      finishProbe?.(false)
    })

    expect(mocks.isNpxOnPath).toHaveBeenCalledTimes(1)
    expect(container?.textContent).not.toContain('Node.js is required')
    expect(mocks.terminalProps.at(-1)?.description).toBe(RUN_DESCRIPTION)
  })

  it('fails open when the probe rejects', async () => {
    mocks.isNpxOnPath.mockRejectedValue(new Error('ipc unavailable'))

    await renderTerminal()

    expect(mocks.terminalProps.at(-1)?.description).toBe(RUN_DESCRIPTION)
  })

  it('re-checks after Node.js is installed', async () => {
    mocks.isNpxOnPath.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await renderTerminal()

    const recheck = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Re-check'
    )
    expect(recheck).toBeDefined()
    await act(async () => {
      recheck?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(mocks.isNpxOnPath).toHaveBeenCalledTimes(2)
    expect(mocks.isNpxOnPath).toHaveBeenNthCalledWith(2, undefined, { forceRefresh: true })
    expect(mocks.terminalProps.at(-1)?.command).toBe(INSTALL_COMMAND)
  })

  it('opens the Node.js download in the external browser', async () => {
    mocks.isNpxOnPath.mockResolvedValue(false)
    await renderTerminal()

    const download = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Download Node.js'
    )
    download?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(mocks.openUrl).toHaveBeenCalledWith('https://nodejs.org/')
  })
})

describe('getFeatureSetupNpxPreflightContext', () => {
  it('targets the configured WSL distro', () => {
    expect(getFeatureSetupNpxPreflightContext('win32', 'wsl.exe', ' Ubuntu ')).toEqual({
      wslDistro: 'Ubuntu'
    })
  })

  it('targets the default distro when none is configured', () => {
    expect(
      getFeatureSetupNpxPreflightContext('win32', 'C:\\Windows\\System32\\wsl.exe', null)
    ).toEqual({ wslDefault: true })
  })

  it.each([
    ['darwin', 'zsh'],
    ['linux', 'bash'],
    ['win32', 'powershell.exe'],
    ['win32', 'cmd.exe'],
    ['win32', 'C:\\Program Files\\Git\\bin\\bash.exe']
  ] as const)('uses the host PATH for %s with %s', (platform, shell) => {
    expect(getFeatureSetupNpxPreflightContext(platform, shell, null)).toBeUndefined()
  })
})
