import type { ProcessTableRow } from './process-table-snapshot'
import type { TmuxManagedPty } from './tmux-agent-hook-owner'

export const TMUX_TEST_PANE = 'tab-tmux:22222222-2222-4222-8222-222222222222'
export const TMUX_TEST_ROOT: TmuxManagedPty = {
  pid: 100,
  incarnation: 'first',
  scope: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace',
    workspaceKind: 'folder'
  }
}
export const TMUX_TEST_ROWS: ProcessTableRow[] = [
  {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S',
    startTime: 'root',
    command: '/bin/bash'
  },
  {
    pid: 101,
    ppid: 100,
    pgid: 101,
    tpgid: 101,
    tty: 'pts/1',
    stat: 'S+',
    startTime: 'client',
    command: '/usr/bin/tmux attach'
  }
]
export function tmuxTestBody(pane = '%0') {
  return {
    paneKey: TMUX_TEST_PANE,
    tabId: 'tab-tmux',
    worktreeId: 'workspace',
    launchToken: 'generation',
    tmux: { socket: '/tmp/test.sock', pane },
    payload: { hook_event_name: 'SessionIdle', prompt: 'completed', session_id: 'session' }
  }
}
