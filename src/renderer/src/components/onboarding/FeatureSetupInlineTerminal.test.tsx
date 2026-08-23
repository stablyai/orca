// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'

const mocks = vi.hoisted(() => ({
  runtime: {
    agentRuntime: {
      runtime: 'wsl' as const,
      wslDistro: 'Ubuntu',
      hostPlatform: 'win32' as const,
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'WSL Ubuntu'
    },
    installDisabledReason: null as string | null,
    terminalShellOverride: 'powershell.exe'
  },
  buildCommand: vi.fn(
    (command: string, runtime?: { runtime: 'host' | 'wsl' }) =>
      `${runtime?.runtime ?? 'host'}:${command}`
  ),
  buildSetupCommand: vi.fn(
    (command: string, shellOverride: string | undefined, runtime?: { runtime: 'host' | 'wsl' }) =>
      `${runtime?.runtime ?? 'host'}-${shellOverride ?? 'default'}:${command}`
  ),
  terminalProps: null as {
    command: string
    forceHostRuntime?: boolean
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    runtimeEnvironmentId?: string | null
    shellOverride?: string
  } | null
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.runtime
}))

vi.mock('../settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: mocks.buildCommand,
  buildSkillSetupTerminalCommand: mocks.buildSetupCommand
}))

vi.mock('./OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    forceHostRuntime?: boolean
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    runtimeEnvironmentId?: string | null
    shellOverride?: string
  }) => {
    mocks.terminalProps = props
    return null
  }
}))

const SELECTION = {
  browserUse: false,
  computerUse: false,
  orchestration: true,
  linearTickets: false
}

describe('FeatureSetupInlineTerminal', () => {
  beforeEach(() => {
    mocks.runtime.installDisabledReason = null
    mocks.runtime.agentRuntime.runtimeOwnershipResolved = true
    mocks.terminalProps = null
    mocks.buildCommand.mockClear()
    mocks.buildSetupCommand.mockClear()
  })

  it('runs the command through the resolved WSL runtime', () => {
    render(
      <FeatureSetupInlineTerminal command="npx skills add orchestration" selection={SELECTION} />
    )

    expect(mocks.buildCommand).toHaveBeenCalledWith('npx skills add orchestration', {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'WSL Ubuntu'
    })
    expect(mocks.terminalProps).toMatchObject({
      command: 'wsl:npx skills add orchestration',
      forceHostRuntime: false,
      runtimeEnvironmentId: null,
      shellOverride: 'powershell.exe'
    })
    expect(
      mocks.terminalProps?.prepareCommandForShell?.('wsl:npx skills add orchestration', 'wsl.exe')
    ).toBe('wsl-wsl.exe:wsl:npx skills add orchestration')
  })

  it('uses the host command builder when the WSL runtime needs repair', () => {
    mocks.runtime.installDisabledReason = 'The selected WSL distro is unavailable.'

    render(
      <FeatureSetupInlineTerminal command="npx skills add orchestration" selection={SELECTION} />
    )

    expect(mocks.buildCommand).toHaveBeenCalledWith('npx skills add orchestration', {
      runtime: 'host',
      hostPlatform: 'win32',
      runtimeEnvironmentId: null,
      runtimeOwnershipResolved: true,
      label: 'Windows'
    })
    expect(mocks.terminalProps).toMatchObject({
      command: 'host:npx skills add orchestration',
      forceHostRuntime: true,
      runtimeEnvironmentId: null,
      shellOverride: 'powershell.exe'
    })
    expect(
      mocks.terminalProps?.prepareCommandForShell?.('host:npx skills add orchestration', 'wsl.exe')
    ).toBe('host-wsl.exe:host:npx skills add orchestration')
  })

  it('keeps the runtime captured when setup started', () => {
    render(
      <FeatureSetupInlineTerminal
        command="npx skills add orchestration"
        runtimeContext={{
          agentRuntime: { runtime: 'host', runtimeEnvironmentId: 'hub-a', label: 'Windows' },
          installDisabledReason: null,
          terminalShellOverride: 'cmd.exe'
        }}
        selection={SELECTION}
      />
    )

    expect(mocks.buildCommand).toHaveBeenCalledWith('npx skills add orchestration', {
      runtime: 'host',
      runtimeEnvironmentId: 'hub-a',
      label: 'Windows'
    })
    expect(mocks.terminalProps).toMatchObject({
      command: 'host:npx skills add orchestration',
      runtimeEnvironmentId: 'hub-a',
      shellOverride: 'cmd.exe'
    })
    expect(
      mocks.terminalProps?.prepareCommandForShell?.('host:npx skills add orchestration', 'cmd.exe')
    ).toBe('host-cmd.exe:host:npx skills add orchestration')
  })

  it('does not mount a terminal while runtime ownership is unresolved', () => {
    mocks.runtime.agentRuntime.runtimeOwnershipResolved = false

    const rendered = render(
      <FeatureSetupInlineTerminal command="npx skills add orchestration" selection={SELECTION} />
    )

    expect(rendered.getByText('Preparing setup terminal.')).toBeTruthy()
    expect(mocks.terminalProps).toBeNull()
  })
})
