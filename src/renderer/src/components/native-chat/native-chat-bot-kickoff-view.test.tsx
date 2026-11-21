// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import type { NativeChatStructuredComposerTransport } from './composer/submit/native-chat-structured-composer-transport'

vi.mock('../bots/bot-workspace', () => ({ useBotForWorkspace: () => ({ id: 'bot-1' }) }))

const { useNativeChatBotKickoffView } = await import('./native-chat-bot-kickoff-view')
const { nativeChatFirstScreenSignIn } = await import('../../../../shared/bots/bot-first-screen')

afterEach(cleanup)

const kickoff: NativeChatMessage = {
  id: 'k',
  role: 'user',
  blocks: [{ type: 'text', text: 'Orca: you were just created.' }],
  timestamp: 1,
  source: 'transcript',
  orcaNotice: 'bot-created'
}

it("keeps agy's sign-in on a first screen whose kickoff was refused as signed out", () => {
  // The host's own row for a kickoff agy refused before signing in.
  const rejection = { kind: 'notSignedIn', account: 'system' } as const
  const session = {
    isWorking: false,
    submissions: [
      { dispatchState: 'rejected' as const, reason: 'Antigravity isn’t signed in.', rejection }
    ]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the first screen never reads the transport.
  const transport = {} as NativeChatStructuredComposerTransport

  const { result } = renderHook(() =>
    useNativeChatBotKickoffView([kickoff], session, transport, 'folder:bot')
  )

  expect(nativeChatFirstScreenSignIn(result.current.firstScreen)).toEqual({ account: 'system' })
})
