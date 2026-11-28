// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AskPrompt } from '../../../../../shared/native-chat/input/questions/native-chat-ask-types'
import {
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  releaseNativeChatViewTabs
} from '../pane/ownership/native-chat-view-memory'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'

const PROMPT: AskPrompt = {
  questions: [{ question: 'Ship it?', multiSelect: false, options: [{ label: 'Yes' }] }],
  replyAsMessage: true
}

vi.mock('./use-native-chat-async-questions', () => ({
  useNativeChatAsyncQuestions: () => ({
    prompt: PROMPT,
    answerPending: false,
    dismiss: () => {},
    ownerKey: 'owner'
  })
}))
// The card is a plain button: the test is about whether a remounted chat still holds the answer it was sending.
vi.mock('./NativeChatQuestionCard', () => ({
  NativeChatQuestionCard: (props: {
    isSubmitting: boolean
    onAnswer: (selections: unknown[]) => void
  }) => (
    <button disabled={props.isSubmitting} onClick={() => props.onAnswer([{ indices: [0] }])}>
      Answer
    </button>
  )
}))

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }

beforeEach(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [{ id: TAB.tabId } as Tab] } })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

const answerButton = (view: ReturnType<typeof render>): HTMLButtonElement => {
  const found = view.getByRole('button')
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error('Answer is not a button')
  }
  return found
}

it('a chat released while its answer is sending returns without offering a second answer', () => {
  let settle = (): void => {}
  const send = vi.fn<NativeChatStructuredComposerTransport['send']>((_text, _files, options) => {
    settle = () => options?.onSettled?.('recorded')
    return true
  })
  const view = () =>
    render(
      <NativeChatViewTabContext value={TAB}>
        <NativeChatStructuredAsyncQuestion
          paneKey="pane"
          sourceKey="source"
          sourceScope="scope"
          session={{ messages: [], readPhase: 'ready' }}
          send={send}
        />
      </NativeChatViewTabContext>
    )
  const first = view()
  act(() => first.getByRole('button').click())
  first.unmount()
  const again = view()
  expect(answerButton(again).disabled).toBe(true)
  act(() => settle())
  expect(answerButton(again).disabled).toBe(false)
  // Settled with nothing left to wait on: the kept answer is dropped, so rewinds don't pile them up.
  expect(readNativeChatViewMemory(TAB, 'async-answer:scope')).toBeUndefined()
  expect(send).toHaveBeenCalledTimes(1)
})
