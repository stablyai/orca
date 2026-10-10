// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import { perClientLoader } from '@/lib/launch-parity-renderer-fixture'

const activateAndRevealFolderWorkspace = vi.hoisted(() => vi.fn())
vi.mock('@/lib/worktree-activation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  activateAndRevealFolderWorkspace
}))

const load = perClientLoader(async () => ({
  submit: await import('./folder-workspace-composer-submit')
}))

const FOLDER: FolderWorkspace = {
  id: 'fw-1',
  projectGroupId: 'pg-1',
  name: 'folder',
  folderPath: String.raw`C:\Users\alice\platform\folder`,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}
const SETTINGS = getDefaultSettings('C:\\Users\\alice')

// Pins main's current launch behaviour as the convergence parity baseline (row 8, folder-workspace
// composer on a local Windows C:\ parent): quoted for the client in its Windows shell, with the
// typed note on the command line.
describe('row 8: local Windows folder-workspace composer startup on main', () => {
  beforeAll(async () => {
    await load('win32')
  }, 240_000)
  afterEach(() => {
    activateAndRevealFolderWorkspace.mockReset()
    vi.unstubAllGlobals()
  })

  it.each([
    {
      shell: 'powershell.exe',
      command: "claude '--dangerously-skip-permissions' 'Fix Bob''s bug'",
      agentCommand: "claude '--dangerously-skip-permissions'"
    },
    {
      shell: 'cmd.exe',
      command: `claude "--dangerously-skip-permissions" "Fix Bob's bug"`,
      agentCommand: 'claude "--dangerously-skip-permissions"'
    }
  ])('$shell', async ({ shell, command, agentCommand }) => {
    const { submit } = await load('win32')
    activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
    // As folder-submit-orchestration.ts passes the composer's settings.
    await submit.submitFolderWorkspaceCreate({
      projectGroup: {
        id: 'pg-1',
        name: 'Platform',
        parentPath: String.raw`C:\Users\alice\platform`,
        parentGroupId: null,
        createdFrom: 'folder-scan',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      },
      name: 'folder',
      lastAutoName: '',
      linkedWorkItem: null,
      note: "Fix Bob's bug",
      quickAgent: 'claude',
      autoRenameBranchFromWork: false,
      agentCmdOverrides: SETTINGS.agentCmdOverrides,
      agentArgs: resolveTuiAgentLaunchArgs('claude', SETTINGS.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv('claude', SETTINGS.agentDefaultEnv),
      terminalWindowsShell: shell,
      isRemote: false,
      launchSource: 'new_workspace_composer',
      createFolderWorkspace: async () => FOLDER,
      onOpenChange: vi.fn()
    })

    expect(activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup).toEqual({
      command,
      launchConfig: {
        agentCommand,
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: {}
      },
      env: {},
      launchToken: expect.stringMatching(/^[0-9a-f-]{36}$/),
      launchAgent: 'claude',
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
  })
})
