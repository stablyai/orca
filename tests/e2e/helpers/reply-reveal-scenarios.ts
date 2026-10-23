import { expect } from '@stablyai/playwright-test'
import type { FakeReplyAgentProvider } from './reply-reveal-fake-agent'
import type { ReplyRevealHarness } from './reply-reveal-harness'

export async function runReplyScenarios(
  h: ReplyRevealHarness,
  provider: FakeReplyAgentProvider
): Promise<void> {
  const program = await h.openAgent(provider)
  await h.lookElsewhere()
  await h.programSend(program, 'worker instruction from orca')
  await h.waitForSubmissions(program, 1)
  await h.complete(`${provider} terminal.send`, program, false)
  expect(h.hooks(program, 'UserPromptSubmit')).toBe(2)

  // Each workspace has its own burst cooldown; neither completion waits for time to pass.
  await h.lookAtOtherWorkspace()
  const human = await h.openAgent(provider)
  await h.humanType(human, 'explain the build')
  await h.waitForSubmissions(human, 1)
  await h.lookElsewhere()
  await h.complete(`${provider} typed prompt`, human, true)
  expect(h.hooks(human, 'UserPromptSubmit')).toBe(1)
}
