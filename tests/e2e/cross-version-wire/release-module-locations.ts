import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Modules main has moved, current location first. A release defines each at whichever path it
// shipped, so suites can name either one and still load the rolling baseline and older pinned refs.
// Add an entry when a move would otherwise break the next cut's checkout.
const MOVED_MODULES: readonly (readonly string[])[] = [
  [
    'src/main/claude/structured/journal/claude-structured-journal-translation.ts',
    'src/main/claude/claude-structured-journal-translation.ts'
  ],
  [
    'src/main/runtime/agent-session/records/agent-session-record-rows.ts',
    'src/main/runtime/agent-session-record-rows.ts'
  ],
  [
    'src/main/runtime/agent-session/records/agent-session-recovery-capsule.ts',
    'src/main/runtime/agent-session-recovery-capsule.ts'
  ],
  [
    'src/main/runtime/agent-session/records/agent-session-store-draft.ts',
    'src/main/runtime/agent-session-store-draft.ts'
  ],
  [
    'src/main/runtime/agent-session/records/agent-session-store-state.ts',
    'src/main/runtime/agent-session-store-state.ts'
  ],
  [
    'src/shared/agent-session/agent-session-context-usage-schema.ts',
    'src/shared/agent-session-context-usage-schema.ts'
  ],
  [
    'src/shared/agent-session/failures/agent-session-failure-words.ts',
    'src/shared/agent-session-failure-words.ts'
  ],
  [
    'src/shared/agent-session/failures/agent-session-failure.ts',
    'src/shared/agent-session-failure.ts'
  ],
  [
    'src/shared/agent-session/failures/agent-session-refusal-notice.ts',
    'src/shared/agent-session-refusal-notice.ts'
  ],
  [
    'src/shared/agent-session/failures/structured-agent-session-read-refusal.ts',
    'src/shared/structured-agent-session-read-refusal.ts'
  ],
  [
    'src/shared/agent-session/journal/agent-session-journal-schemas.ts',
    'src/shared/agent-session-journal-schemas.ts'
  ],
  [
    'src/shared/agent-session/lifecycle/agent-session-lease-adjudication.ts',
    'src/shared/agent-session-lease-adjudication.ts'
  ],
  [
    'src/shared/agent-session/lifecycle/agent-session-record.ts',
    'src/shared/agent-session-record.ts'
  ],
  [
    'src/shared/agent-session/lifecycle/agent-session-turn-record.ts',
    'src/shared/agent-session-turn-record.ts'
  ],
  [
    'src/shared/agent-session/structured-agent-session-reducer.ts',
    'src/shared/structured-agent-session-reducer.ts'
  ],
  [
    'src/shared/agent-session/view/structured-agent-session-agent-status.ts',
    'src/shared/structured-agent-session-agent-status.ts'
  ],
  [
    'src/shared/agent-session/view/structured-agent-session-message-projection.ts',
    'src/shared/structured-agent-session-message-projection.ts'
  ],
  [
    'src/shared/agent-session/view/structured-agent-session-projection.ts',
    'src/shared/structured-agent-session-projection.ts'
  ],
  [
    'src/shared/agent-session/view/structured-agent-session-status-block.ts',
    'src/shared/structured-agent-session-status-block.ts'
  ],
  [
    'src/shared/agent-session/view/structured-agent-session-tab.ts',
    'src/shared/structured-agent-session-tab.ts'
  ]
]

/** Where the release under `root` defines the module a suite names; unknown or absent paths pass through. */
export function releaseModuleLocation(
  root: string,
  rootRelativePath: string,
  exists: (path: string) => boolean = existsSync
): string {
  const named = rootRelativePath.replace(/^[/\\]+/, '')
  if (exists(join(root, named))) {
    return named
  }
  const locations = MOVED_MODULES.find((candidates) => candidates.includes(named))
  return locations?.find((candidate) => exists(join(root, candidate))) ?? named
}
