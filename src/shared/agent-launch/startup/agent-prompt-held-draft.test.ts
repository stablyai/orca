import { expect, it } from 'vitest'
import { isHeldAgentPromptDraft } from './agent-prompt-injection'

it('recognizes a complete mixed Codex paste only with caller-owned composer evidence', () => {
  const prefix = 'You are a dispatched worker.\nPreserve drafts.\n'
  const hidden = 'Review the isolated source and reply once.\n'.repeat(80)
  const suffix = '\nFinish this task.'
  const prompt = prefix + hidden + suffix
  const draft = `${prefix}[Pasted Content\n${hidden.length} chars]${suffix}`
  expect(isHeldAgentPromptDraft(draft, prompt, 1)).toBe(false)
  expect(isHeldAgentPromptDraft(draft, prompt, 1, {})).toBe(true)
  expect(isHeldAgentPromptDraft(`${draft} user edit`, prompt, 1, {})).toBe(false)
  expect(isHeldAgentPromptDraft(`user draft ${draft}`, prompt, 1, {})).toBe(false)
  expect(isHeldAgentPromptDraft(draft.replace(prefix, 'A different worker.'), prompt, 1, {})).toBe(
    false
  )
  expect(isHeldAgentPromptDraft(draft.replace(String(hidden.length), '20'), prompt, 1, {})).toBe(
    false
  )
  expect(isHeldAgentPromptDraft(draft.replace(String(hidden.length), '99999'), prompt, 1, {})).toBe(
    false
  )
  expect(isHeldAgentPromptDraft(`[Pasted Content\n${prompt.length} chars]`, prompt, 1)).toBe(true)
})

it('accounts for a scrolled prefix only with owned clipped-composer evidence', () => {
  const scrolled = '🧪 Earlier dispatch line.'.repeat(100)
  const visible = '🧪 Visible dispatch line.\n'
  const hidden = 'Hidden task content.'.repeat(100)
  const prompt = scrolled + visible + hidden
  const draft = `${visible}[Pasted Content ${hidden.length} chars]`
  expect(isHeldAgentPromptDraft(draft, prompt, 1, {})).toBe(false)
  expect(isHeldAgentPromptDraft(draft, prompt, 1, { clipped: true })).toBe(true)
  expect(
    isHeldAgentPromptDraft(draft.replace(visible, 'Foreign draft'), prompt, 1, { clipped: true })
  ).toBe(false)
  expect(
    isHeldAgentPromptDraft(draft.replace(String(hidden.length), '20'), prompt, 1, { clipped: true })
  ).toBe(false)
})
