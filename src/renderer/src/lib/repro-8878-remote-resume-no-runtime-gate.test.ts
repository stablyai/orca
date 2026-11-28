/**
 * Issue #8878 — Remote client resumes live host agent sessions, spawning
 * duplicate TUIs on the same provider session.
 *
 * Root cause (code-level):
 * 1. `resumeSleepingAgentSessionsForWorktree` is called on worktree activation
 *    and Terminal startup hydration with no runtime-ownership gate.
 * 2. Plain terminal auto-create already short-circuits when
 *    `isWebRuntimeSessionActive(...)` (host-authoritative session-tabs).
 * 3. Resume guards (`recordPaneIsOwnedByPreservedPane`,
 *    `activeOrQueuedResumeClaimsProviderSession`) only consult client-local
 *    state, so a still-live host session is invisible until the async
 *    session-tabs mirror arrives.
 *
 * Fix PR (open): #8887 — gate resume at the choke point for runtime-owned worktrees.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/lib/repro-8878-remote-resume-no-runtime-gate.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const resumeSource = readFileSync(join(__dirname, 'resume-sleeping-agent-session.ts'), 'utf8')
const activationSource = readFileSync(join(__dirname, 'worktree-activation.ts'), 'utf8')
const terminalSource = readFileSync(join(__dirname, '../components/Terminal.tsx'), 'utf8')

describe('#8878 remote client resume lacks runtime-ownership gate', () => {
  it('resumeSleepingAgentSessionsForWorktree has no isWebRuntimeSessionActive short-circuit', () => {
    // Positive control: the function exists and is the resume choke point.
    expect(resumeSource).toMatch(
      /export function resumeSleepingAgentSessionsForWorktree\s*\(\s*worktreeId:\s*string/
    )
    // Bug: no host-authority gate on the resume path (fix PR #8887 adds it).
    expect(resumeSource).not.toMatch(/isWebRuntimeSessionActive/)
    expect(resumeSource).not.toMatch(/getRuntimeEnvironmentIdForWorktree/)
  })

  it('worktree activation always invokes resume (no runtime gate at call site)', () => {
    // Both folder-workspace and repo worktree activation call resume.
    expect(activationSource).toMatch(/resumeSleepingAgentSessionsForWorktree\(workspaceKey\)/)
    expect(activationSource).toMatch(/resumeSleepingAgentSessionsForWorktree\(worktreeId\)/)
    // Auto-create for runtime-owned worktrees IS gated nearby — asymmetric.
    expect(activationSource).toMatch(
      /isWebRuntimeSessionActive\(getRuntimeEnvironmentIdForWorktree/
    )
  })

  it('Terminal auto-create gates on web runtime, but startup resume does not', () => {
    // Auto-create short-circuit (host session-tabs authoritative)
    expect(terminalSource).toMatch(
      /isWebRuntimeSessionActive\(getActiveWorktreeRuntimeEnvironmentId\(activeWorktreeId\)\)/
    )
    // Startup hydration still resumes unconditionally after that gate block.
    expect(terminalSource).toMatch(/resumeSleepingAgentSessionsForWorktree\(activeWorktreeId\)/)
    // Extract the startup-resume effect body roughly: resume call is not
    // preceded by an isWebRuntimeSessionActive return in the same effect.
    const startupEffect = terminalSource.match(
      /startupResumeWorktreeIdsRef[\s\S]{0,800}?resumeSleepingAgentSessionsForWorktree\(activeWorktreeId\)/
    )
    expect(startupEffect).not.toBeNull()
    expect(startupEffect![0]).not.toMatch(/isWebRuntimeSessionActive/)
  })
})
