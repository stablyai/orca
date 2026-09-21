// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CliSkillSetupTerminal } from './CliSkillSetupTerminal'

const mocks = vi.hoisted(() => ({
  runtime: {
    agentRuntime: { runtime: 'wsl' as const, wslDistro: 'Missing', label: 'WSL Missing' },
    installDisabledReason: 'The selected WSL distro is unavailable.',
    terminalShellOverride: 'powershell.exe'
  },
  terminalCommand: ''
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.runtime
}))

vi.mock('@/components/onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    prepareCommandForShell,
    shellOverride
  }: {
    command: string
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    shellOverride?: string
  }) => {
    mocks.terminalCommand = prepareCommandForShell?.(command, shellOverride) ?? command
    return null
  }
}))

describe('CliSkillSetupTerminal', () => {
  beforeEach(() => {
    mocks.terminalCommand = ''
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: 'win32' }) }
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
  })
})
