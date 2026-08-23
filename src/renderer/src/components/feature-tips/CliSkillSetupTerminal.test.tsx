// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CliSkillSetupTerminal } from './CliSkillSetupTerminal'

const mocks = vi.hoisted(() => ({
  runtime: {
    agentRuntime: {
      runtime: 'wsl' as const,
      wslDistro: 'Missing',
      hostPlatform: 'win32' as const,
      runtimeEnvironmentId: 'hub-a',
      runtimeOwnershipResolved: true,
      label: 'WSL Missing'
    },
    installDisabledReason: 'The selected WSL distro is unavailable.' as string | null,
    terminalShellOverride: 'powershell.exe'
  },
  terminalCommand: '',
  runtimeEnvironmentId: undefined as string | null | undefined
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.runtime
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    prepareCommandForShell,
    runtimeEnvironmentId,
    shellOverride
  }: {
    command: string
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    runtimeEnvironmentId?: string | null
    shellOverride?: string
  }) => {
    mocks.terminalCommand = prepareCommandForShell?.(command, shellOverride) ?? command
    mocks.runtimeEnvironmentId = runtimeEnvironmentId
    return null
  }
}))

describe('CliSkillSetupTerminal', () => {
  beforeEach(() => {
    mocks.terminalCommand = ''
    mocks.runtimeEnvironmentId = undefined
    mocks.runtime.installDisabledReason = 'The selected WSL distro is unavailable.'
    mocks.runtime.agentRuntime.runtimeOwnershipResolved = true
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: 'darwin' }) }
      }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  it('runs the Windows host fallback when the selected WSL runtime needs repair', () => {
    render(
      <TooltipProvider>
        <CliSkillSetupTerminal />
      </TooltipProvider>
    )

    expect(mocks.terminalCommand).toMatch(/^cmd\.exe \/d \/s \/c /)
    expect(mocks.terminalCommand).not.toContain('wsl.exe')
    expect(mocks.runtimeEnvironmentId).toBe('hub-a')
  })

  it('does not mount a terminal while runtime ownership is unresolved', () => {
    mocks.runtime.installDisabledReason = null
    mocks.runtime.agentRuntime.runtimeOwnershipResolved = false

    const rendered = render(
      <TooltipProvider>
        <CliSkillSetupTerminal />
      </TooltipProvider>
    )

    expect(rendered.getByText('Preparing setup terminal.')).toBeTruthy()
    expect(mocks.terminalCommand).toBe('')
  })
})
