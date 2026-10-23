/**
 * Reply-reveal scenarios with their fixed expected answers (S-numbers from the design table). The
 * expected value is the ideal behaviour, never adjusted to what the build does.
 */
import { expect } from '@stablyai/playwright-test'
import type { ReplyRevealHarness } from './reply-reveal-harness'
import { setBringToFront, setProbeWindowFocused } from './reply-reveal-probes'

export async function runClaudeReplyScenarios(h: ReplyRevealHarness): Promise<void> {
  const claude = await h.openAgent('claude')
  let submitted = 0

  // S1: typed prompt and Enter, then the person looks at another tab.
  await h.humanType(claude, 'explain the build')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S1 claude typed prompt', claude, true)

  // S2: same, but main sees a focused Orca window.
  await h.humanType(claude, 'second question')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await setProbeWindowFocused(h.app, true)
  await h.complete('S2 claude focused window', claude, false, { banners: 0 })
  await setProbeWindowFocused(h.app, false)

  // S1/S2 with another workspace in view: the banner shows, so only the reveal's own focus check decides.
  await h.humanType(claude, 'third question')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookAtOtherWorkspace()
  await h.complete('S1 claude typed prompt, other workspace in view', claude, true)
  await h.humanType(claude, 'fourth question')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookAtOtherWorkspace()
  await setProbeWindowFocused(h.app, true)
  await h.complete('S2 claude focused window, other workspace in view', claude, false)
  await setProbeWindowFocused(h.app, false)

  // S5/S17: Orca writes the prompt and its Enter.
  await h.lookElsewhere()
  await h.programSend(claude, 'worker instruction from orca')
  await h.waitForSubmissions(claude, ++submitted)
  await h.complete('S17 claude terminal.send', claude, false)

  // S6: the person types into the same tab Orca wrote to.
  await h.humanType(claude, 'person follow-up')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S6 claude person in program tab', claude, true)

  // S7: a person's /status Enter, then Orca's message starts the turn.
  await h.humanType(claude, '/status')
  await h.programSend(claude, 'message after status')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S7 claude status then program', claude, false)

  // S16: a person approves during Orca's turn; the background-task wake that follows.
  await h.programSend(claude, 'program turn needing approval')
  await h.waitForSubmissions(claude, ++submitted)
  await h.humanType(claude, '')
  await h.lookElsewhere()
  await h.complete('S16 claude program turn after approval Enter', claude, false)
  await h.complete('S16 claude task-notification wake after approval', claude, false, {
    wake: true
  })
  submitted++

  // S4: a person's turn, then a task-notification wake with no new keystroke.
  await h.humanType(claude, 'start background job')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S4 claude person turn before wake', claude, true)
  await h.complete('S4 claude task-notification wake', claude, false, { wake: true })
  submitted++

  // S18: dictation fills the draft through Orca's paste path; the person presses Enter.
  await h.dictateDraft(claude, 'dictated draft')
  await h.humanType(claude, '')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S18 claude dictated draft, person Enter', claude, true)

  // S10: auto-compaction during a person's turn keeps it the person's reply.
  await h.humanType(claude, 'long task that compacts')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.compact(claude)
  await h.complete('S10 claude person turn compacted mid-turn', claude, true)

  // S12: the setting is off.
  await setBringToFront(h.page, false)
  await h.humanType(claude, 'with the setting off')
  await h.waitForSubmissions(claude, ++submitted)
  await h.lookElsewhere()
  await h.complete('S12 claude setting off', claude, false)
  await h.finishChain()
  await setBringToFront(h.page, true)

  expect(h.hooks('claude', 'UserPromptSubmit')).toBe(submitted)
}

export async function runCodexReplyScenarios(h: ReplyRevealHarness): Promise<void> {
  const codex = await h.openAgent('codex')
  let submitted = 0

  await h.humanType(codex, 'explain the build')
  await h.waitForSubmissions(codex, ++submitted)
  await h.lookElsewhere()
  await h.complete('S1 codex typed prompt', codex, true)
  // S4/S14: subagent mail wakes a new turn id that has no submission hook.
  await h.complete('S4 codex wake without submission', codex, false, { wake: true })

  await h.lookElsewhere()
  await h.programSend(codex, 'worker instruction from orca')
  await h.waitForSubmissions(codex, ++submitted)
  await h.complete('S17 codex terminal.send', codex, false)

  // S3c: a person steers into a turn Orca started.
  await h.programSend(codex, 'program turn to steer')
  await h.waitForSubmissions(codex, ++submitted)
  await h.humanType(codex, 'person steering')
  await h.waitForSubmissions(codex, ++submitted)
  await h.lookElsewhere()
  await h.complete('S3c codex person steers program turn', codex, true)

  await h.humanType(codex, '/status')
  await h.programSend(codex, 'message after status')
  await h.waitForSubmissions(codex, ++submitted)
  await h.lookElsewhere()
  await h.complete('S7 codex status then program', codex, false)

  await h.programSend(codex, 'program turn needing approval')
  await h.waitForSubmissions(codex, ++submitted)
  await h.humanType(codex, '')
  await h.lookElsewhere()
  await h.complete('S16 codex program turn after approval Enter', codex, false)
  await h.complete('S16 codex wake after approval', codex, false, { wake: true })

  // S12 starts after cleanup of the linked approval/wake chain.
  await h.finishChain()
  await h.humanType(codex, 'with the setting off')
  await h.waitForSubmissions(codex, ++submitted)
  await h.lookElsewhere()
  await h.complete('S12 codex setting off', codex, false)
  await h.finishChain()
  await setBringToFront(h.page, true)

  expect(h.hooks('codex', 'UserPromptSubmit')).toBe(submitted)
}
