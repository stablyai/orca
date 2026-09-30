import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'

const SOURCE_ROOT = resolve(__dirname, '..')
// Both read a bare agent name as `idle`; `classifyTitleActivity` is the renderer's pass-through.
const IDLE_GUESS_READER = /\b(?:detectAgentStatusFromTitle|classifyTitleActivity)\b/

// Why: the wrapper is temporary, so its importers may only shrink. Readers that say what a
// title shows use `readAgentTitleActivity`, which answers `unreported` for a bare name.
const KNOWN_IDLE_GUESS_READERS = [
  'main/runtime/orca-runtime-apply-tracked-pty-title.ts',
  'main/runtime/orca-runtime-get-pty-record-for-pane-key.ts',
  'main/runtime/orca-runtime-get-unpersisted-tracked-title-for-pty.ts',
  'main/runtime/orca-runtime-maybe-hydrate-headless-from-renderer.ts',
  'main/runtime/orca-runtime-record-agent-prompt-lifecycle-state.ts',
  'main/runtime/runtime-terminal-agent-status-query.ts',
  'main/runtime/runtime-worktree-status-projection.ts',
  'main/runtime/terminal-wait-detection.ts',
  'renderer/src/components/status-bar/workspace-space-presentation.ts',
  'renderer/src/components/terminal-pane/agent-completion-title-observer.ts',
  'renderer/src/components/terminal-pane/cache-timer-seeding.ts',
  'renderer/src/components/terminal-pane/pty-connection-test-environment.ts',
  'renderer/src/components/terminal-pane/pty-connection/agent-task-complete-notify.ts',
  'renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts',
  'renderer/src/components/terminal-pane/pty-connection/interrupt-input-intent.ts',
  'renderer/src/components/terminal-pane/pty-connection/shell-command-inference.ts',
  'renderer/src/components/terminal-pane/pty-output-title-observer.ts',
  'renderer/src/components/terminal-pane/title-agent-identity.ts',
  'renderer/src/lib/active-agent-note-target.ts',
  'renderer/src/lib/agent-ready-wait.ts',
  'renderer/src/lib/agent-send-title-status.ts',
  'renderer/src/lib/agent-status-terminal-title.ts',
  'renderer/src/lib/agent-status.ts',
  'renderer/src/lib/pane-agent-evidence.ts',
  'renderer/src/lib/worktree-status.ts',
  'renderer/src/store/slices/terminal-helpers.ts',
  'renderer/src/store/slices/workspace-cleanup-local-evidence.ts',
  'renderer/src/store/terminals/terminal-ephemeral-state.ts',
  'renderer/src/store/terminals/terminal-tab-presentation.ts',
  'shared/agent-decorative-title-signature.ts',
  'shared/agent-detection.ts',
  'shared/agent-title-owner.ts',
  'shared/agent-title-status.ts',
  'shared/terminal-output-side-effects.ts',
  'shared/tui-agent-rest-signal.ts'
]

describe('temporary name-as-idle title reader ratchet', () => {
  const readers = scanSourceTree(SOURCE_ROOT)
    .filter((file) => IDLE_GUESS_READER.test(stripComments(file.source)))
    .map((file) => file.relativePath)
    .sort()

  it('admits no new reader of the name-as-idle guess', () => {
    expect(readers.filter((path) => !KNOWN_IDLE_GUESS_READERS.includes(path))).toEqual([])
  })

  it('drops a file from the list once it stops reading the guess', () => {
    expect(KNOWN_IDLE_GUESS_READERS.filter((path) => !readers.includes(path))).toEqual([])
  })
})
