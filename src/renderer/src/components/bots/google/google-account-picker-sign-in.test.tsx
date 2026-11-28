// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  NativeChatViewTabContext,
  releaseNativeChatViewTabs
} from '../../native-chat/pane/ownership/native-chat-view-memory'
import { GoogleAccountPicker, type GoogleAccountPickerBot } from './GoogleAccountPicker'

const connection = vi.hoisted(() => ({
  connectGoogle: vi.fn(() => new Promise<never>(() => {})),
  cancelGoogleSignIn: vi.fn(() => Promise.resolve()),
  useGoogleHost: () => ({ status: 'ready', google: { accounts: [] } })
}))
// The host round trip is the boundary: the login stays open until the person finishes it.
vi.mock('./google-connect-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...connection
}))

const TAB = { tabId: 'tab-1', worktreeId: 'wt-1' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the picker reads the bot's id, name, members and host.
const BOT = {
  id: 'bot-1',
  name: 'Bot',
  members: [],
  hostId: 'local'
} as unknown as GoogleAccountPickerBot

beforeEach(() => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these checks read only a tab's id.
  useAppStore.setState({ unifiedTabsByWorktree: { [TAB.worktreeId]: [{ id: TAB.tabId } as Tab] } })
})
afterEach(() => {
  cleanup()
  releaseNativeChatViewTabs([TAB.tabId])
})

it("a sign-in from a chat setup card's account picker is still waiting, and cancellable, after a switch away and back", () => {
  const picker = () =>
    render(
      <NativeChatViewTabContext value={TAB}>
        <GoogleAccountPicker
          bot={BOT}
          chosen={[]}
          onChosenChange={() => {}}
          signInMemoryKey="picker:run-1"
        />
      </NativeChatViewTabContext>
    )
  const first = picker()
  act(() => first.getByRole('button', { name: /Add another account/ }).click())
  first.unmount()
  const again = picker()
  act(() => again.getByRole('button', { name: /Cancel/ }).click())
  expect(connection.cancelGoogleSignIn).toHaveBeenCalledTimes(1)
  expect(again.queryByRole('button', { name: /Cancel/ })).toBeNull()
})
