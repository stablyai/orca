// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZcodeCliSetupSection } from './ZcodeCliSetupSection'

const defaultUserAgent = navigator.userAgent
const mocks = vi.hoisted(() => ({
  settings: { agentCmdOverrides: { zcode: '' }, terminalWindowsShell: 'powershell.exe' },
  capability: vi.fn(),
  setupInvocation: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks)
}))
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    description,
    prepareCommandForShell,
    shellOverride,
    forceHostRuntime
  }: {
    command: string
    description: string
    prepareCommandForShell?: (command: string, shell?: string) => string
    shellOverride?: string
    forceHostRuntime?: boolean
  }) => (
    <div
      data-testid="setup-terminal"
      data-force-host-runtime={String(forceHostRuntime)}
      data-shell-override={shellOverride}
    >
      <output>{prepareCommandForShell?.(command, shellOverride) ?? command}</output>
      <p>{description}</p>
    </div>
  )
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

beforeEach(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: defaultUserAgent
  })
  mocks.settings.agentCmdOverrides.zcode = ''
  mocks.settings.terminalWindowsShell = 'powershell.exe'
  mocks.capability.mockReset().mockResolvedValue('interactive')
  mocks.setupInvocation
    .mockReset()
    .mockImplementation(async ({ cliArgs }: { cliArgs: string[] }) => ({
      command: 'zcode',
      args: cliArgs,
      env: {}
    }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: {
        zcodeInteractiveCapability: mocks.capability,
        zcodeSetupInvocation: mocks.setupInvocation
      }
    }
  })
})
afterEach(() => cleanup())

describe('ZCode CLI-owned sign-in setup', () => {
  it.each([
    ['Z.AI browser sign-in', "'zcode' 'login' 'zai' '--no-browser'"],
    ['BigModel browser sign-in', "'zcode' 'login' 'bigmodel' '--no-browser'"],
    ['ZCode API-key setup', "'zcode' 'tui'"]
  ])('delegates %s to the supported upstream CLI command', async (label, command) => {
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(command)
    expect(screen.getByTestId('setup-terminal')).toHaveAttribute('data-force-host-runtime', 'true')
    expect(screen.getByRole('button', { name: 'Z.AI browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'BigModel browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'ZCode API-key setup' })).toBeDisabled()
    if (label === 'ZCode API-key setup') {
      expect(screen.getByText(/enter \/login.*masked prompt/)).toBeInTheDocument()
    } else {
      expect(screen.getByText(/authorization URL printed by ZCode/)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close setup terminal' }))
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeEnabled()
  })

  it('uses a native host shell when the Windows terminal default is WSL', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Windows'
    })
    mocks.settings.terminalWindowsShell = 'wsl.exe'
    mocks.setupInvocation.mockResolvedValue({
      command: 'C:\\Program Files\\ZCode\\ZCode.exe',
      args: ['C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs', 'login', 'zai', '--no-browser'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })

    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Z.AI browser sign-in' }))

    const terminal = await screen.findByTestId('setup-terminal')
    expect(terminal).toHaveAttribute('data-shell-override', 'powershell.exe')
    expect(terminal).toHaveTextContent("$env:ELECTRON_RUN_AS_NODE = '1'")
  })

  it('runs browser sign-in through the resolved desktop bundle invocation', async () => {
    mocks.setupInvocation.mockResolvedValue({
      command: '/opt/ZCode/zcode',
      args: ['/opt/ZCode/resources/glm/zcode.cjs', 'login', 'bigmodel', '--no-browser'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'BigModel browser sign-in' }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(
      "ELECTRON_RUN_AS_NODE='1' '/opt/ZCode/zcode' '/opt/ZCode/resources/glm/zcode.cjs' 'login' 'bigmodel' '--no-browser'"
    )
    expect(mocks.setupInvocation).toHaveBeenCalledWith({
      cliArgs: ['login', 'bigmodel', '--no-browser']
    })
  })

  it('passes a configured multi-token CLI command to main for safe resolution', async () => {
    mocks.settings.agentCmdOverrides.zcode = 'node "C:\\ZCode CLI\\zcode.cjs"'
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'BigModel browser sign-in' }))
    await screen.findByTestId('setup-terminal')
    expect(mocks.setupInvocation).toHaveBeenCalledWith({
      commandOverride: 'node "C:\\ZCode CLI\\zcode.cjs"',
      cliArgs: ['login', 'bigmodel', '--no-browser']
    })
  })

  it('refuses API-key setup when the installed bundle has no TUI', async () => {
    mocks.capability.mockResolvedValue('missing-tui')
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'ZCode API-key setup' }))
    await vi.waitFor(() => expect(mocks.capability).toHaveBeenCalled())
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(mocks.setupInvocation).not.toHaveBeenCalled()
  })
})
