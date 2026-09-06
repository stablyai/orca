# Canvas note context

## Interaction

Drag a note's connector onto an agent. The latest note snapshot is synchronized to
the execution runtime and returned by Orca's managed CLI hook at a supported boundary.
There is no Send action, terminal paste, synthetic Enter, or automatic agent turn.

Editing a note updates future snapshots. Disconnecting or deleting it stops future
inclusion after synchronization; it cannot erase context already in the conversation.
Switching tabs keeps attachments active. Closing a canvas clears only that canvas's
host snapshot and waits for acknowledgment; an unavailable host leaves the canvas open.

## Native adapters

| CLI         | Delivery boundary                                                     | Limits                                                                                   |
| ----------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Codex       | UserPromptSubmit / SessionStart, hookSpecificOutput.additionalContext | 32,000 note characters per canvas/agent; Codex may spill long hook output to a file.     |
| Claude Code | UserPromptSubmit / SessionStart, hookSpecificOutput.additionalContext | 32,000 note characters per canvas/agent.                                                 |
| Cursor CLI  | postToolUse, additional_context                                       | 9,000 note characters per canvas/agent; a prompt that uses no tool gets no new snapshot. |

Up to 32 attached notes per agent. Aggregate snapshots from multiple canvases are
bounded before storage (63,000 characters per pane; 9,500 for Cursor). Oversized
updates fail explicitly and preserve the last accepted snapshot.

Cursor's installed 2026.09.02 CLI carrier rejects context over 10,000 characters;
the lower limits reserve space for headings. The adapter uses the documented tool
boundary rather than assuming every CLI version accepts prompt-submit context.

Official contracts checked on 2026-09-05: [Codex hooks](https://developers.openai.com/codex/hooks),
[Claude hooks](https://code.claude.com/docs/en/hooks), [Cursor hooks](https://cursor.com/docs/hooks).

## Ownership and compatibility

`agentHooks.canvasContext` accepts revisioned full snapshots. The runtime resolves
the exact live pane/PTY and verifies local execution ownership. A registry beside
the hook endpoint persists notes with restricted file permissions and atomic replacement.
Bindings are fenced by workspace, pane, provider session, and hashed launch token.
Replacing a terminal/session does not silently transfer its attachments. Reconnect
the note to explicitly attach it to the new session.

The existing status-hook transport opts into response bodies using
`X-Orca-Canvas-Context: 1`. Old hooks still receive HTTP 204. Updated scripts emit one
complete JSON result, retaining permission-safe fallbacks on timeout or errors.
Replay and background/subagent events cannot consume root-session notes.

Paired desktop runtimes use the existing host routing and owning runtime's registry.
Older runtimes report unsupported. Direct SSH relay context is **not implemented**;
it reports unsupported and never writes remote notes to a local execution registry.
Loss of contact reports unverifiable, not process death. Folder workspaces do not
require Git. No workspace-wide AGENTS.md, CLAUDE.md, or Cursor rules are written.

## Status semantics

- Waiting: the terminal or managed root-session hook has not supplied an identity.
- Ready: the owning runtime accepted the snapshot for the indicated next boundary.
- Returned to agent hook: the listener produced the native context response. This
  is transport evidence, not proof the model read or followed the note.
- Session changed: reconnect the note to explicitly adopt the replacement session.
- Unsupported / unverifiable / update failure: no delivery claim; the last accepted
  snapshot may still be active until removal reaches the execution host.

## Validation

Store tests cover edits, detach, revision ordering, workspace/session fences,
background/replay exclusion, limits, and durable first-session binding. HTTP and
executable generated-hook tests exercise Codex, Claude, and Cursor JSON output,
legacy 204 behavior, authentication, and Cursor's permission fallback.

`ORCA_CANVAS_CLI_SMOKE=1 pnpm exec vitest run --config config/vitest.config.ts src/main/agent-hooks/canvas-context-claude-cli.test.ts`
additionally runs the installed Claude CLI against a local model stub and verifies
that the note reaches its model request without changing the user's prompt. It does
not modify user configuration or consume model credits. Live model consumption by
Codex/Cursor and rendered Windows/paired-runtime delivery have not been smoke-tested here.

`agent-canvas-context.spec.ts` exercises rendered connection and delivery status via
the actual Electron RPC/hook listener. Existing canvas/browser specs retain pointer,
persistence, and native browser embedding coverage.
