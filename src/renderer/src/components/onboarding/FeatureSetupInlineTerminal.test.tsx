// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'

const mocks = vi.hoisted(() => ({
  runtime: {
    agentRuntime: { runtime: 'wsl' as const, wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
    installDisabledReason: null as string | null,
    terminalShellOverride: 'powershell.exe'
  },
  buildCommand: vi.fn(
    (command: string, runtime?: { runtime: 'host' | 'wsl' }) =>
      `${runtime?.runtime ?? 'host'}:${command}`
  ),
  buildSetupCommand: vi.fn(
    (command: string, _shellOverride: string | undefined, runtime?: { runtime: 'host' | 'wsl' }) =>
      `${runtime?.runtime ?? 'host'}-setup:${command}`
  ),
  terminalProps: null as { command: string; shellOverride?: string } | null
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.runtime
}))

vi.mock('../settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: mocks.buildCommand,
  buildSkillSetupTerminalCommand: mocks.buildSetupCommand
}))

vi.mock('./OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: { command: string; shellOverride?: string }) => {
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
      label: 'WSL Ubuntu'
    })
    expect(mocks.terminalProps).toMatchObject({
      command: 'wsl-setup:wsl:npx skills add orchestration',
      shellOverride: 'powershell.exe'
    })
  })

  it('uses the host command builder when the WSL runtime needs repair', () => {
    mocks.runtime.installDisabledReason = 'The selected WSL distro is unavailable.'

    render(
      <FeatureSetupInlineTerminal command="npx skills add orchestration" selection={SELECTION} />
    )

    expect(mocks.buildCommand).toHaveBeenCalledWith('npx skills add orchestration', undefined)
    expect(mocks.terminalProps).toMatchObject({
      command: 'host-setup:host:npx skills add orchestration',
      shellOverride: 'powershell.exe'
    })
  })

  it('keeps the runtime captured when setup started', () => {
    render(
      <FeatureSetupInlineTerminal
        command="npx skills add orchestration"
        runtimeContext={{
          agentRuntime: { runtime: 'host', label: 'Windows' },
          installDisabledReason: null,
          terminalShellOverride: 'cmd.exe'
        }}
        selection={SELECTION}
      />
    )

    expect(mocks.buildCommand).toHaveBeenCalledWith('npx skills add orchestration', {
      runtime: 'host',
      label: 'Windows'
    })
    expect(mocks.terminalProps).toMatchObject({
      command: 'host-setup:host:npx skills add orchestration',
      shellOverride: 'cmd.exe'
    })
  })
})
