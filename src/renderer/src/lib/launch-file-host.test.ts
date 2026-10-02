import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clientLaunchHost, launchHostIsPaired } from './launch-file-host'
import { localPwshAvailability } from './local-pwsh-availability'

vi.mock('./local-pwsh-availability', () => ({ localPwshAvailability: vi.fn(() => null) }))
import { buildQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'

describe('whether a launch lands on a paired host', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false for this machine and true for another Orca or a web client', () => {
    expect(launchHostIsPaired(null)).toBe(false)
    expect(launchHostIsPaired('env-1')).toBe(true)
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    expect(launchHostIsPaired(null)).toBe(true)
  })
})

describe('the quick composer on a paired host', () => {
  it('sends no pointer to a paired host and leaves the prompt for the renderer to paste', () => {
    const startup = buildQuickComposerStartup({
      agent: 'claude',
      prompt: 'fix the build\nthen run the tests',
      draftPrompt: null,
      settings: null,
      repoConnectionId: null,
      platform: 'linux',
      shell: null,
      isRemote: false,
      host: {
        paired: true,
        provesAgentInFront: true,
        takesLaunchFile: false,
        windowsPaneShell: null
      },
      telemetrySource: 'sidebar'
    })
    expect(startup.backendStartup).toBeUndefined()
    expect(startup.startupPlan?.launchFile).toBeUndefined()
    expect(startup.startupPlan?.pastePromptAfterReady).toBe('fix the build\nthen run the tests')
  })
})

// Why: this client spawns its own Windows panes, so it knows the PowerShell that gets the line.
describe('the PowerShell a local Windows launch from this client lands in', () => {
  afterEach(() => {
    vi.mocked(localPwshAvailability).mockReturnValue(null)
  })

  const host = (isRemote = false) =>
    clientLaunchHost({ runtimeEnvironmentId: null, launchPlatform: 'win32', isRemote })

  it('follows this client’s shell settings and the pwsh probe', () => {
    const settings = useAppStore.getState().settings
    useAppStore.setState({
      settings: {
        ...settings!,
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'auto'
      }
    })
    expect(host().windowsPaneShell).toBeNull()
    vi.mocked(localPwshAvailability).mockReturnValue(false)
    expect(host().windowsPaneShell).toBe('powershell.exe')
    vi.mocked(localPwshAvailability).mockReturnValue(true)
    expect(host().windowsPaneShell).toBe('pwsh.exe')
    expect(host(true).windowsPaneShell).toBeNull()
    useAppStore.setState({ settings })
  })
})
