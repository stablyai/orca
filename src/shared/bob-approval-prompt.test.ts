import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBobApprovalPromptDetector, textShowsBobApprovalPrompt } from './bob-approval-prompt'
import { stripTerminalControl } from './terminal-control-stripping'

const FIXTURE_DIR = join(__dirname, '../main/runtime/__fixtures__')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, `${name}.txt`), 'utf-8')
}

function armedDetector() {
  return createBobApprovalPromptDetector({ startupCommand: 'bob chat --trust' })
}

function countFirings(detector: ReturnType<typeof armedDetector>, writes: string[]): number {
  return writes.filter((write) => detector.observe(write)).length
}

/** Replays a transcript the way a PTY delivers it, so the rolling window is exercised. */
function countFiringsOverChunks(transcript: string, chunkSize: number): number {
  const chunks: string[] = []
  for (let index = 0; index < transcript.length; index += chunkSize) {
    chunks.push(transcript.slice(index, index + chunkSize))
  }
  return countFirings(armedDetector(), chunks)
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
    '    Reject\n'
  ].join('\n')

  const SUBAGENT_SPAWN_APPROVAL = [
    '  Subagent (general)',
    '  → Approve Once',
    '    Approve subagent tools for task',
    '    Reject\n'
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

  it('fires once per modal and re-arms after the composer returns', () => {
    const detector = armedDetector()
    // Bob repaints the modal every frame; the row must not re-fire.
    expect(countFirings(detector, [COMMAND_APPROVAL, COMMAND_APPROVAL, COMMAND_APPROVAL])).toBe(1)
    // Answering it repaints the composer with no menu, which disarms.
    expect(countFirings(detector, [IDLE_COMPOSER, SUBAGENT_SPAWN_APPROVAL])).toBe(1)
  })

  // Why: output between repaints (spinner, subagent rows) says nothing about the modal leaving.
  it('stays armed across writes that lack both the modal and the composer', () => {
    const detector = armedDetector()
    const spinner = `\n ⠋ Processing… (Enter to steer, Tab to queue)\n${' '.repeat(600)}`
    expect(countFirings(detector, [COMMAND_APPROVAL, spinner, COMMAND_APPROVAL, spinner])).toBe(1)
  })

  it('detects a modal split across PTY writes', () => {
    const detector = armedDetector()
    expect(detector.observe('  Execute Command\n  Approve comm')).toBe(false)
    expect(detector.observe('ands:\n  → Approve Once\n')).toBe(true)
  })

  it('detects a menu line split across three PTY writes', () => {
    const detector = armedDetector()
    expect(countFirings(detector, ['  Subagent (general)\n  → Ap', 'pro', 've Once\n'])).toBe(1)
  })

  // Why: the safety property that matters most — an unrelated CLI printing this exact menu text
  // must never light up a Bob status row on a pane that never ran Bob.
  it('never fires without first proving the pane is really Bob', () => {
    const detector = createBobApprovalPromptDetector({ startupCommand: 'node ./cli.js' })
    expect(countFirings(detector, [COMMAND_APPROVAL, SUBAGENT_SPAWN_APPROVAL])).toBe(0)
  })

  it('arms on the composer banner alone, with no startup command evidence', () => {
    const detector = createBobApprovalPromptDetector({ startupCommand: null })
    expect(countFirings(detector, [IDLE_COMPOSER, COMMAND_APPROVAL])).toBe(1)
  })

  it('arms fast on a bob chat startup command, before any banner is seen', () => {
    expect(countFirings(armedDetector(), [COMMAND_APPROVAL])).toBe(1)
  })

  // Why the real transcripts and several chunk sizes: the rule is only as good as the screen it
  // was written against, and one fire per modal must not depend on where PTY writes split.
  it.each([64, 512, 4096])(
    'fires once for the captured main-agent approval (%i-byte writes)',
    (size) => {
      const transcript = readFixture('bob-approval-command')
      expect(textShowsBobApprovalPrompt(stripTerminalControl(transcript))).toBe(true)
      expect(countFiringsOverChunks(transcript, size)).toBe(1)
    }
  )

  // Spawn approval, then the subagent's execute approval repainted ~140 times.
  it.each([64, 512, 4096])(
    'fires once per modal in the captured subagent transcript (%i-byte writes)',
    (size) => {
      const transcript = readFixture('bob-approval-subagent')
      expect(stripTerminalControl(transcript)).toContain('Approve subagent tools for task')
      expect(countFiringsOverChunks(transcript, size)).toBe(2)
    }
  )
})
