import { describe, expect, it } from 'vitest'
import { resolveDashboardCardTerminalInput } from '../dashboard/dashboard-card-terminal-input'
import { resolvePreviewShortcutAction } from './preview-terminal-shortcuts'
import { getDefaultSettings } from '../../../../shared/constants'
import type { DashboardCardTerminalInputState } from '../dashboard/dashboard-card-terminal-input'

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron'
const PANE_KEY = 'tab-1:leaf-1'
const CMD_IDLE_TITLE = 'C:\\WINDOWS\\system32\\cmd.exe'

function previewCtrlBackspace(args: {
  ptyId?: string
  shellOverride?: string
  defaultShell?: string
  paneTitle?: string
  state?: Partial<DashboardCardTerminalInputState>
}): string | undefined {
  const terminalInput = resolveDashboardCardTerminalInput(
    {
      repos: [
        { id: 'repo-1', path: 'C:\\repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
      ],
      settings: {
        ...getDefaultSettings(process.cwd()),
        terminalWindowsShell: args.defaultShell ?? 'powershell.exe'
      },
      ...args.state
    },
    {
      ptyId: args.ptyId ?? 'pty-1',
      worktreeId: 'repo-1::C:\\repo',
      paneKey: PANE_KEY,
      cwd: 'C:\\repo',
      shellOverride: args.shellOverride,
      paneTitle: args.paneTitle ?? CMD_IDLE_TITLE,
      launchAgent: null,
      clientPlatform: 'win32',
      userAgent: WINDOWS_UA,
      osRelease: '10.0.26200'
    }
  )
  const action = resolvePreviewShortcutAction(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only these key fields; Node has no KeyboardEvent.
    {
      key: 'Backspace',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false
    } as KeyboardEvent,
    {
      clientPlatform: 'win32',
      macOptionAsAlt: 'false',
      optionKeyLocations: 0,
      keybindings: undefined,
      terminalInput,
      getKittyKeyboardFlags: () => 0,
      terminalShortcutPolicy: undefined
    }
  )
  return action?.type === 'sendInput' ? action.data : undefined
}

describe('dashboard preview Ctrl+Backspace', () => {
  it('sends BS for a local cmd pane from the tab override or the default shell', () => {
    expect(previewCtrlBackspace({ shellOverride: 'cmd.exe' })).toBe('\b')
    expect(previewCtrlBackspace({ defaultShell: 'cmd.exe' })).toBe('\b')
  })

  it('keeps Ctrl+W for an agent, other shells and remote panes', () => {
    expect(
      previewCtrlBackspace({
        shellOverride: 'cmd.exe',
        state: {
          paneForegroundAgentByPaneKey: { [PANE_KEY]: { agent: 'claude', shellForeground: false } }
        }
      })
    ).toBe('\x17')
    expect(
      previewCtrlBackspace({ shellOverride: 'cmd.exe', paneTitle: `${CMD_IDLE_TITLE} - wsl` })
    ).toBe('\x17')
    expect(previewCtrlBackspace({ shellOverride: 'powershell.exe' })).toBe('\x17')
    expect(previewCtrlBackspace({ shellOverride: 'cmd.exe', ptyId: 'ssh:box@@pty-1' })).toBe('\x17')
  })
})
