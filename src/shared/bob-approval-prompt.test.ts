import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBobApprovalPromptDetector, textShowsBobApprovalPrompt } from './bob-approval-prompt'
import { stripTerminalControl } from './terminal-control-stripping'

const FIXTURE_DIR = join(__dirname, '../main/runtime/__fixtures__')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf-8')
}

function armedDetector(onApprovalPrompt: () => void) {
  return createBobApprovalPromptDetector({ startupCommand: 'bob chat --trust' }, onApprovalPrompt)
}

/** Replays a transcript the way a PTY delivers it, so the rolling window is exercised. */
function countFiringsOverChunks(transcript: string, chunkSize: number): number {
  let firings = 0
  const detector = armedDetector(() => {
    firings += 1
  })
  for (let index = 0; index < transcript.length; index += chunkSize) {
    detector.observe(transcript.slice(index, index + chunkSize))
  }
  return firings
}

describe('Bob approval prompt detection', () => {
  // Why verbatim: these are the two modals captured from Bob 2.0.2; the command approval is the
  // only one carrying `Approve commands:`, so a rule written against it alone misses the spawn.
  const COMMAND_APPROVAL = [
    '  Execute Command',
    '  Command:          ls -la',
    '  Approve commands:',
    '  → Approve Once',
    '    Always Allow Command for task',
    '    Reject'
  ].join('\n')

  const SUBAGENT_SPAWN_APPROVAL = [
    '  Subagent (general)',
    '  → Approve Once',
    '    Approve subagent tools for task',
    '    Reject'
  ].join('\n')

  const IDLE_COMPOSER = '  ❯   Build Anything, @ for context, / for commands, $ for skills\n'

  it('matches the command-approval modal', () => {
    expect(textShowsBobApprovalPrompt(COMMAND_APPROVAL)).toBe(true)
  })

  // Why its own case: the spawn modal has no `Approve commands:` line at all.
  it('matches the subagent-spawn modal', () => {
    expect(textShowsBobApprovalPrompt(SUBAGENT_SPAWN_APPROVAL)).toBe(true)
  })

  it('ignores an idle composer and ordinary output', () => {
    expect(textShowsBobApprovalPrompt(IDLE_COMPOSER)).toBe(false)
    expect(textShowsBobApprovalPrompt('$ git commit -m "approve the change"')).toBe(false)
    // Why: prose mentioning the menu must not arm the row; only the rendered menu line does.
    expect(textShowsBobApprovalPrompt('I will approve once you confirm.')).toBe(false)
  })

  it('fires once per modal and re-arms for the next one', () => {
    let firings = 0
    const detector = armedDetector(() => {
      firings += 1
    })

    detector.observe(COMMAND_APPROVAL)
    expect(firings).toBe(1)
    // Bob repaints the modal every frame; the row must not re-fire.
    detector.observe(COMMAND_APPROVAL)
    detector.observe(COMMAND_APPROVAL)
    expect(firings).toBe(1)

    // Answering it repaints a screen with no menu, which disarms.
    detector.observe(IDLE_COMPOSER)
    expect(firings).toBe(1)

    detector.observe(SUBAGENT_SPAWN_APPROVAL)
    expect(firings).toBe(2)
  })

  it('detects a modal split across PTY writes', () => {
    let firings = 0
    const detector = armedDetector(() => {
      firings += 1
    })
    detector.observe('  Execute Command\n  Approve comm')
    expect(firings).toBe(0)
    detector.observe('ands:\n  → Approve Once\n')
    expect(firings).toBe(1)
  })

  // Why: the safety property that matters most — an unrelated CLI printing this exact menu text
  // must never light up a Bob status row on a pane that never ran Bob.
  it('never fires without first proving the pane is really Bob', () => {
    let firings = 0
    const detector = createBobApprovalPromptDetector({ startupCommand: 'node ./cli.js' }, () => {
      firings += 1
    })
    detector.observe(COMMAND_APPROVAL)
    detector.observe(SUBAGENT_SPAWN_APPROVAL)
    expect(firings).toBe(0)
  })

  it('arms on the composer banner alone, with no startup command evidence', () => {
    let firings = 0
    const detector = createBobApprovalPromptDetector({ startupCommand: null }, () => {
      firings += 1
    })
    detector.observe(IDLE_COMPOSER)
    detector.observe(COMMAND_APPROVAL)
    expect(firings).toBe(1)
  })

  it('arms fast on a bob chat startup command, before any banner is seen', () => {
    let firings = 0
    const detector = createBobApprovalPromptDetector({ startupCommand: 'bob chat --trust' }, () => {
      firings += 1
    })
    // No banner observed yet — the startup command alone must be enough.
    detector.observe(COMMAND_APPROVAL)
    expect(firings).toBe(1)
  })

  // Why the real transcripts: the rule is only as good as the screen it was written against.
  it('finds the approval in the captured main-agent transcript', () => {
    const transcript = readFixture('bob-approval-command')
    expect(textShowsBobApprovalPrompt(stripTerminalControl(transcript))).toBe(true)
    expect(countFiringsOverChunks(transcript, 512)).toBeGreaterThan(0)
  })

  it('finds the approval in the captured subagent transcript', () => {
    const transcript = readFixture('bob-approval-subagent')
    const stripped = stripTerminalControl(transcript)
    expect(textShowsBobApprovalPrompt(stripped)).toBe(true)
    // Why: proves the spawn modal is present and distinct, not just the command one.
    expect(stripped).toContain('Approve subagent tools for task')
    expect(countFiringsOverChunks(transcript, 512)).toBeGreaterThan(0)
  })
})
