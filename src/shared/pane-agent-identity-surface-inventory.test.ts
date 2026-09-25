import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'
import { isTestFile, stripComments } from './source-scan/source-tree-scan'

/**
 * Surface half of the identity inventory ratchet: every consumer decision point from the closed
 * 65-row inventory (rows 32–65 — the direct title/native-chat selectors, tab projections, mobile
 * sync graph, lifecycle selectors, status/OSC ingress, worktree status, attention, and
 * title-reset paths) is pinned to a marker symbol in its file. The helper-name census
 * (`pane-agent-identity-inventory.test.ts`) is necessary but not sufficient — these files reach
 * identity through direct reads a name census cannot see. Moving or renaming a marker means the
 * inventory row must be re-classified, deliberately, before review.
 */

type SurfaceRow = {
  /** Row number in the closed consumer inventory. */
  row: number
  path: string
  marker: string
}

const SURFACE_ROWS: readonly SurfaceRow[] = [
  {
    row: 32,
    path: 'src/renderer/src/components/terminal-pane/native-chat-leaf-title-agent.ts',
    marker: 'resolveNativeChatLeafTitleAgent'
  },
  {
    row: 32,
    path: 'src/renderer/src/components/terminal-pane/use-terminal-pane-chat-state.ts',
    marker: 'resolveNativeChatLeafTitleAgent'
  },
  {
    row: 33,
    path: 'src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity.ts',
    marker: 'installPaneAgentIdentity'
  },
  { row: 34, path: 'src/main/runtime/orchestration/groups.ts', marker: 'terminalIsAgent' },
  {
    row: 35,
    path: 'src/renderer/src/lib/active-agent-note-target.ts',
    marker: 'getActiveTerminalNoteTarget'
  },
  {
    row: 36,
    path: 'src/renderer/src/components/terminal-pane/terminal-agent-paste-bracketing.ts',
    marker: 'resolveProtectedMultilinePasteOptionsForPane'
  },
  {
    row: 37,
    path: 'src/renderer/src/components/terminal-pane/command-code-output-ownership.ts',
    marker: 'canCommandCodeOutputOwnPane'
  },
  { row: 38, path: 'src/renderer/src/lib/agent-ready-wait.ts', marker: 'waitForAgentReady' },
  {
    row: 39,
    path: 'src/renderer/src/lib/agent-paste-draft.ts',
    marker: 'getSettingsForAgentTabRuntimeOwner'
  },
  {
    row: 40,
    path: 'src/renderer/src/lib/agent-followup-delivery.ts',
    marker: 'sendFollowupPromptWhenAgentReady'
  },
  {
    row: 41,
    path: 'src/renderer/src/lib/codex-session-restart.ts',
    marker: 'markLiveCodexSessionsForRestart'
  },
  {
    row: 41,
    path: 'src/renderer/src/lib/codex-pane-restart-eligibility.ts',
    marker: 'isCodexForegroundProcess'
  },
  {
    row: 42,
    path: 'src/renderer/src/components/native-chat/native-chat-availability.ts',
    marker: 'canToggleNativeChat'
  },
  {
    row: 43,
    path: 'src/renderer/src/components/native-chat/native-chat-pane-resolution.ts',
    marker: 'resolveNativeChatSession'
  },
  {
    row: 44,
    path: 'src/renderer/src/components/terminal-pane/terminal-agent-session-continuation.ts',
    marker: 'canContinueAgentSessionInNewSession'
  },
  {
    row: 45,
    path: 'src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts',
    marker: 'prepareAgentSessionForkFromPane'
  },
  {
    row: 46,
    path: 'src/renderer/src/components/terminal-pane/agent-interrupt-inference.ts',
    marker: 'isPlainEscapeKeyEvent'
  },
  {
    row: 46,
    path: 'src/renderer/src/components/terminal-pane/agent-question-answered-inference.ts',
    marker: 'inferQuestionAnsweredFromCurrentStatus'
  },
  {
    row: 47,
    path: 'src/renderer/src/components/terminal-pane/terminal-keyboard-protocol-pane-agent.ts',
    marker: 'resolvePaneKeyboardProtocolAgent'
  },
  {
    row: 47,
    path: 'src/renderer/src/components/terminal-pane/terminal-pane-manager-options.ts',
    marker: 'resolvePaneKeyboardProtocolAgent'
  },
  {
    row: 48,
    path: 'src/renderer/src/components/tab-bar/tab-agent-types-by-tab-id.ts',
    marker: 'selectTabAgentTypesByTabId'
  },
  {
    row: 49,
    path: 'src/renderer/src/components/terminal-pane/terminal-tab-agent-type-index.ts',
    marker: 'createTerminalTabAgentTypeSelector'
  },
  {
    row: 50,
    path: 'src/renderer/src/lib/tab-agent-status-index.ts',
    marker: 'selectLiveTabAgentPanes'
  },
  {
    row: 51,
    path: 'src/renderer/src/components/tab-bar/terminal-tab-activity-status.ts',
    marker: 'resolveTerminalTabActivityStatus'
  },
  {
    row: 52,
    path: 'src/renderer/src/lib/workspace-tab-agent-metadata.ts',
    marker: 'maxAgentActivityAt'
  },
  {
    row: 52,
    path: 'src/renderer/src/lib/workspace-tab-palette-entry-builder.ts',
    marker: 'buildSearchableWorkspaceTabEntries'
  },
  {
    row: 53,
    path: 'src/renderer/src/lib/running-agent-targets.ts',
    marker: 'deriveRunningAgentSendTargets'
  },
  {
    row: 54,
    path: 'src/renderer/src/runtime/sync-runtime-graph.ts',
    marker: 'buildMobileSessionTabSnapshots'
  },
  {
    row: 55,
    path: 'src/renderer/src/lib/agent-hibernation-pane-eligibility.ts',
    marker: 'toRuntimePtyId'
  },
  {
    row: 56,
    path: 'src/renderer/src/lib/resume-sleeping-agent-session.ts',
    marker: 'resumeSleepingAgentSessionsForWorktree'
  },
  {
    row: 57,
    path: 'src/renderer/src/lib/automation-session-reuse.ts',
    marker: 'findReusableAutomationSession'
  },
  {
    row: 58,
    path: 'src/renderer/src/components/terminal-pane/pty-connection/cold-restore-resume-startup.ts',
    marker: 'bindBuildColdRestoreAgentResumeStartup'
  },
  {
    row: 59,
    path: 'src/main/agent-hooks/server/server-authority-evidence.ts',
    marker: 'recordCurrentAuthorityObservation'
  },
  {
    row: 59,
    path: 'src/main/runtime/orca-runtime-write-orchestration-pointer-pty.ts',
    marker: 'resolvePaneAgentIdentityField'
  },
  {
    row: 59,
    path: 'src/renderer/src/hooks/ipc-events/agent-status-event-applicator.ts',
    marker: 'createAgentStatusEventApplicator'
  },
  {
    row: 59,
    path: 'src/renderer/src/store/slices/agent-status-authority-actions.ts',
    marker: 'transferAgentPaneAuthority'
  },
  {
    row: 59,
    path: 'src/renderer/src/store/slices/pane-foreground-agent.ts',
    marker: 'createPaneForegroundAgentSlice'
  },
  {
    row: 59,
    path: 'src/renderer/src/hooks/ipc-events/agent-status-routing.ts',
    marker: 'isAgentStatusForRecentlyClosedTab'
  },
  {
    row: 60,
    path: 'src/renderer/src/components/terminal-pane/pty-connection/title-spawn-bell.ts',
    marker: 'installTitleSpawnBell'
  },
  { row: 61, path: 'src/renderer/src/lib/worktree-status.ts', marker: 'getWorktreeStatus' },
  {
    row: 62,
    path: 'src/main/runtime/runtime-worktree-status-projection.ts',
    marker: 'getLeafWorktreeStatus'
  },
  {
    row: 63,
    path: 'src/renderer/src/components/sidebar/smart-attention.ts',
    marker: 'buildAttentionByWorktree'
  },
  {
    row: 64,
    path: 'src/renderer/src/components/status-bar/workspace-space-presentation.ts',
    marker: 'countWorkspaceSpaceActiveAgents'
  },
  { row: 65, path: 'src/renderer/src/store/slices/terminal-helpers.ts', marker: 'getResetTitle' },
  {
    row: 6,
    path: 'src/renderer/src/runtime/web-session-tabs-sync.ts',
    marker: 'applyWebSessionTabs'
  }
]

describe('pane agent identity surface inventory (rows 6, 32–65)', () => {
  it('every pinned surface still carries its marker symbol', () => {
    for (const row of SURFACE_ROWS) {
      const source = stripComments(readFileSync(join(process.cwd(), row.path), 'utf8'))
      expect({ row: row.row, path: row.path, hasMarker: source.includes(row.marker) }).toEqual({
        row: row.row,
        path: row.path,
        hasMarker: true
      })
    }
  })
})

/**
 * Identity-observation rebind audit. Advancing a pane incarnation without a positive replacement
 * proof is how a legitimate reclaim and a stale-hook bug get conflated (see
 * `PaneReplacementProof` in pane-agent-identity-adapter.ts). Every existing sequencer `rebind`
 * call is pinned here by file and count: today they are the retired-pane `restart` disposition
 * (three ingress paths) and the renderer pane-key transfer. Adding a rebind call, or changing
 * these, requires updating this audit — and per the migration plan, a `replacementProof`.
 */
const IDENTITY_SEQUENCER_REBIND_RE = /\b(?:observations|rendererAgentStatusObservations)\.rebind\(/g

const EXPECTED_REBIND_SITES: readonly (readonly [path: string, occurrences: number])[] = [
  ['src/main/agent-hooks/server/server-ingest-normalization.ts', 1],
  ['src/main/agent-hooks/server/server-ingest-remote.ts', 1],
  ['src/main/agent-hooks/server/server-lifecycle.ts', 1],
  ['src/renderer/src/store/slices/agent-status-authority-actions.ts', 1]
]

describe('identity observation rebind audit', () => {
  it('pins every identity-sequencer rebind call site by file and count', async () => {
    const files = await glob(['src/**/*.{ts,tsx}', 'mobile/src/**/*.{ts,tsx}'], {
      ignore: ['**/*.test.*', '**/*.spec.*']
    })
    const actual: [string, number][] = []
    for (const path of files.sort()) {
      if (isTestFile(path)) {
        continue
      }
      const source = stripComments(readFileSync(join(process.cwd(), path), 'utf8'))
      const occurrences = source.match(IDENTITY_SEQUENCER_REBIND_RE)?.length ?? 0
      if (occurrences > 0) {
        actual.push([path, occurrences])
      }
    }
    expect(actual).toEqual(EXPECTED_REBIND_SITES.map((site) => [...site]))
  }, 30_000)
})
