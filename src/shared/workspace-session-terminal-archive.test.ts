import { describe, expect, it } from 'vitest'
import { archivedTerminalPaneSchema, terminalArchiveHintSchema } from './terminal-archive-types'
import {
  captureTerminalArchiveTab,
  createPrioritizedTerminalArchiveSnapshotSource,
  mergeTerminalArchiveHint,
  retireArchivedTerminalTab,
  shouldArchiveTerminalClose
} from './workspace-session-terminal-archive'
import { getDefaultWorkspaceSession } from './constants'
import type { WorkspaceSessionState } from './types'

const WORKTREE_ID = 'repo-1::/worktree'
const TAB_ID = 'terminal-1'
const LEFT_LEAF = '11111111-1111-4111-8111-111111111111'
const RIGHT_LEAF = '22222222-2222-4222-8222-222222222222'

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: 'shared-pty',
          worktreeId: WORKTREE_ID,
          title: 'Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 10,
          startupCwd: '/worktree'
        },
        {
          id: 'other-tab',
          ptyId: 'shared-pty',
          worktreeId: WORKTREE_ID,
          title: 'Other',
          customTitle: null,
          color: null,
          sortOrder: 1,
          createdAt: 11
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.3,
          first: { type: 'leaf', leafId: LEFT_LEAF },
          second: { type: 'leaf', leafId: RIGHT_LEAF }
        },
        activeLeafId: RIGHT_LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEFT_LEAF]: 'shared-pty', [RIGHT_LEAF]: 'shared-pty' },
        titlesByLeafId: { [LEFT_LEAF]: 'Build', [RIGHT_LEAF]: 'Agent' }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [`${TAB_ID}:${LEFT_LEAF}`]: 'left-incarnation',
      [`${TAB_ID}:${RIGHT_LEAF}`]: 'right-incarnation'
    },
    terminalArchiveHintsByPaneKey: {
      [`${TAB_ID}:${RIGHT_LEAF}`]: {
        cwd: '/worktree',
        startupCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' },
        orchestrationTaskId: 'task-1',
        startedAt: 5
      }
    }
  }
}

describe('workspace terminal archive transition', () => {
  it('captures split layout fidelity while stripping process identities', () => {
    const captured = captureTerminalArchiveTab({
      session: session(),
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID
    })

    expect(captured?.layout).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: LEFT_LEAF },
        second: { type: 'leaf', leafId: RIGHT_LEAF }
      },
      activeLeafId: RIGHT_LEAF,
      expandedLeafId: null,
      titlesByLeafId: { [LEFT_LEAF]: 'Build', [RIGHT_LEAF]: 'Agent' }
    })
    expect(JSON.stringify(captured?.layout)).not.toContain('pty')
    expect(captured?.panesByLeafId[RIGHT_LEAF]).toMatchObject({
      cwd: '/worktree',
      agent: { type: 'codex', providerSession: { id: 'session-1' } }
    })
    expect(captured?.sourcePaneIdentityByLeafId).toEqual({
      [LEFT_LEAF]: { paneKey: `${TAB_ID}:${LEFT_LEAF}`, incarnationId: 'left-incarnation' },
      [RIGHT_LEAF]: { paneKey: `${TAB_ID}:${RIGHT_LEAF}`, incarnationId: 'right-incarnation' }
    })
  })

  it('prefers hook facts while retaining the earliest start time', () => {
    const merged = mergeTerminalArchiveHint(
      {
        cwd: '/worktree',
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'old-session' },
        startedAt: 40
      },
      {
        providerSession: { key: 'session_id', id: 'hook-session' },
        orchestrationTaskId: 'task-2',
        startedAt: 20
      },
      'hook'
    )

    expect(merged.providerSession?.id).toBe('hook-session')
    expect(merged.orchestrationTaskId).toBe('task-2')
    expect(merged.startedAt).toBe(20)
  })

  it('does not let a late launch default overwrite hook facts', () => {
    const fromHook = mergeTerminalArchiveHint(
      undefined,
      {
        cwd: '/authoritative-worktree',
        shellOverride: '/bin/zsh',
        launchAgent: 'codex'
      },
      'hook'
    )
    const merged = mergeTerminalArchiveHint(
      fromHook,
      {
        cwd: '/launch-default',
        shellOverride: '/bin/bash',
        launchAgent: 'claude'
      },
      'launch'
    )

    expect(merged).toMatchObject({
      cwd: '/authoritative-worktree',
      shellOverride: '/bin/zsh',
      launchAgent: 'codex'
    })
  })

  it('does not let a late spawn default overwrite sleeping-session facts', () => {
    const fromSleepingSession = mergeTerminalArchiveHint(
      undefined,
      {
        cwd: '/resumed-worktree',
        startupCommand: 'codex resume',
        launchAgent: 'codex'
      },
      'sleeping-session'
    )
    const merged = mergeTerminalArchiveHint(
      fromSleepingSession,
      {
        cwd: '/spawn-default',
        startupCommand: 'codex',
        launchAgent: 'claude'
      },
      'spawn'
    )

    expect(merged).toMatchObject({
      cwd: '/resumed-worktree',
      startupCommand: 'codex resume',
      launchAgent: 'codex'
    })
  })

  it.each([
    [
      'pane agent provider session',
      archivedTerminalPaneSchema,
      {
        archivedLeafId: LEFT_LEAF,
        cwd: '/worktree',
        agent: {
          type: 'codex',
          providerSession: { key: 'session_id', id: 'session-1', unexpected: 'field' }
        }
      }
    ],
    [
      'archive hint provider session',
      terminalArchiveHintSchema,
      {
        providerSession: { key: 'session_id', id: 'session-1', unexpected: 'field' }
      }
    ]
  ])('rejects unknown nested fields in %s', (_description, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it.each(['cleanup', 'pty-exit', 'app-shutdown', 'hibernation', 'pane-close'] as const)(
    'does not archive %s',
    (reason) => {
      expect(shouldArchiveTerminalClose(reason)).toBe(false)
    }
  )

  it('does not kill a PTY still owned by another tab when retiring', () => {
    const retired = retireArchivedTerminalTab(session(), WORKTREE_ID, TAB_ID)

    expect(retired.closed).toBe(true)
    expect(retired.ptyIdsToKill).toEqual([])
    expect(retired.session.terminalArchiveHintsByPaneKey).toBeUndefined()
  })

  it('uses daemon snapshots before renderer, sidecar, and relay fallbacks', async () => {
    const renderer = {
      capture: async () => ({
        kind: 'captured-bytes' as const,
        buffer: 'renderer',
        source: 'renderer' as const,
        truncated: false,
        byteLength: 8
      })
    }
    const source = createPrioritizedTerminalArchiveSnapshotSource({
      daemonAuthoritative: { capture: async () => ({ kind: 'unavailable' as const }) },
      rendererSerializer: renderer,
      sessionSidecar: {
        capture: async () => ({
          kind: 'captured-bytes' as const,
          buffer: 'sidecar',
          source: 'session-sidecar' as const,
          truncated: false,
          byteLength: 7
        })
      },
      relayTail: {
        capture: async () => ({
          kind: 'captured-bytes' as const,
          buffer: 'relay',
          source: 'relay-tail' as const,
          truncated: true,
          byteLength: 5
        })
      }
    })
    const captured = await source.capture({ archivedLeafId: LEFT_LEAF, cwd: '/worktree' })

    expect(captured).toMatchObject({ kind: 'captured-bytes', source: 'renderer' })
  })
})
