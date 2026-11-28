// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  KEPT_PROMPT_VIEWS,
  NativeChatViewTabContext,
  readNativeChatViewMemory,
  releaseNativeChatViewTabs
} from '../native-chat/pane/ownership/native-chat-view-memory'
import { SignInAddressPaste } from './SignInAddressPaste'

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }

beforeEach(() => {
  useAppStore.setState({
    unifiedTabsByWorktree: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
      [TAB.worktreeId]: [{ id: TAB.tabId } as Tab]
    }
  })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it('a tab cycling through many conversations keeps only the newest refused addresses', async () => {
  const conversations = Array.from({ length: 20 }, (_, index) => `local:session-${index}`)
  for (const conversation of conversations) {
    const view = render(
      <NativeChatViewTabContext value={{ ...TAB, conversation }}>
        <SignInAddressPaste
          hint="Paste the address"
          memoryKey="bot:tool"
          onFinish={() => Promise.reject(new Error('refused'))}
          describeError={() => 'refused'}
        />
      </NativeChatViewTabContext>
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: `http://x/${conversation}` } })
    await act(async () => {
      const form = screen.getByRole('textbox').closest('form')
      if (!form) {
        throw new Error('no form')
      }
      fireEvent.submit(form)
      await Promise.resolve()
      await Promise.resolve()
    })
    view.unmount()
  }
  const kept = conversations.filter(
    (conversation) =>
      readNativeChatViewMemory(TAB, `sign-in-address-refused:bot:tool@${conversation}`) !==
      undefined
  )
  expect(kept).toEqual(conversations.slice(-KEPT_PROMPT_VIEWS))
})
