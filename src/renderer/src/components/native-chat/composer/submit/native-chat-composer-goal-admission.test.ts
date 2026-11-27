// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

// The host goal write and the structured sender are recorded stand-ins; goal mode, the outbound
// policy and the draft store run for real.
const { useNativeChatComposerSubmit } = await import('./use-native-chat-composer-submit')
const { readNativeChatComposerDraft, updateNativeChatComposerDraft } =
  await import('../../drafts/native-chat-composer-draft-store')
const { structuredAgentSessionDraftScopeKey } = await import('../../drafts/native-chat-draft-scope')
const { formatNativeChatFileReference } =
  await import('../../../../../../shared/native-chat/input/composer/agent-image-paste')
const { nativeChatBrowserFileRefusalParts } =
  await import('../../attachments/native-chat-browser-file-references')
const { agentSessionWriteNoticeText } =
  await import('../../messages/notices/agent-session-write-notice-text')

beforeEach(() => {
  localStorage.clear()
})

function goalComposer(sessionId: string, hostGoal: boolean) {
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const setObjective = vi.fn(async (_objective: string) => true)
  const sendStructured = vi.fn(async (_text: string) => true)
  const errors: (string | null)[] = []
  const fields = {
    sessionId,
    runtime: 'local',
    optionSnapshot: [],
    capturePresentation: () => () => true,
    onError: (message: string | null) => errors.push(message),
    ...(hostGoal ? { threadGoal: { setObjective } } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields goal mode reads.
  const transport = fields as unknown as NativeChatStructuredComposerTransport
  const hook = renderHook(
    ({ draft }: { draft: string }) =>
      useNativeChatComposerSubmit({
        structuredTransport: transport,
        agent: 'codex',
        draftScopeKey: scope,
        draft,
        caret: draft.length,
        textareaRef: { current: null },
        imageAttachments: [],
        disabled: false,
        sendPty: () => {},
        sendStructured,
        setDraft: (text) => updateNativeChatComposerDraft(scope, { text }, 'immediate'),
        setCaret: () => {}
      }),
    { initialProps: { draft: '' } }
  )
  /** Type `text` into the draft, then press Send. */
  const submit = (text: string): void => {
    updateNativeChatComposerDraft(scope, { text }, 'immediate')
    hook.rerender({ draft: text })
    act(() => hook.result.current.send())
  }
  return { scope, setObjective, sendStructured, errors, submit }
}

// D11-01 / C15-01. A host goal is a content-bearing write. Entered by bare /goal, an objective naming a
// browser file the host can never read is refused before any write; the draft keeps it exactly.
it('refuses a host goal naming a browser file, writing nothing and keeping the draft', async () => {
  const { scope, setObjective, errors, submit } = goalComposer('goal-refused', true)
  submit('/goal')
  const stale = 'orca-browser-file:goal/old.png'
  const objective = `match ${formatNativeChatFileReference(stale)}`

  submit(objective)
  await Promise.resolve()

  expect(setObjective).not.toHaveBeenCalled()
  expect(readNativeChatComposerDraft(scope).text).toBe(objective)
  expect(errors.at(-1)).toBe(
    agentSessionWriteNoticeText(nativeChatBrowserFileRefusalParts([stale]))
  )
})

// The paired control: a goal naming a host path is written exactly once, with exactly its text.
it('writes a host goal naming a host path once, with its exact text', async () => {
  const { setObjective, submit } = goalComposer('goal-valid', true)
  submit('/goal')
  const objective = `match ${formatNativeChatFileReference('/host/agent-session-attachments/u/a.png')}`

  submit(objective)
  await Promise.resolve()

  expect(setObjective.mock.calls).toEqual([[objective]])
})

// Controls: without a host goal, a typed /goal and /compact stay ordinary structured sends (their own
// admission is the composer's), and nothing is written as an objective.
it.each(['/goal ship it', '/compact keep the plan'])('keeps %s an ordinary send', async (text) => {
  const { setObjective, sendStructured, submit } = goalComposer(`goal-control-${text}`, false)

  submit(text)
  await Promise.resolve()

  expect(setObjective).not.toHaveBeenCalled()
  expect(sendStructured.mock.calls.map(([sent]) => sent)).toEqual([text])
})
