// @vitest-environment happy-dom
import { useEffect, useSyncExternalStore } from 'react'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { createBotItemPendingCommentsHook } from '../../../../../shared/bots/bot-item-pending-comments'
import { readNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { writeNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import { botItemCommentDraftScope, returnBotItemCommentDraft } from './bot-item-comment-draft'

const usePendingComments = createBotItemPendingCommentsHook({ useEffect, useSyncExternalStore })
const bot = { id: 'agent', hostId: 'local' } as const

// A typed reply to a question the agent has since replaced: the host refuses it.
async function refusedReply(uid: string, typedSince: string): Promise<string> {
  const scope = botItemCommentDraftScope(bot, uid)
  const hook = renderHook(() =>
    usePendingComments(uid, [], {
      post: () =>
        Promise.reject(Object.assign(new Error('new question'), { code: 'item_changed' })),
      failed: () => {},
      returnText: (text) => returnBotItemCommentDraft(bot, uid, text),
      refresh: () => {},
      requestIds: true,
      questionIds: true,
      plain: true
    })
  )
  await act(async () => {
    hook.result.current.send('the internal ones', [], null, 'e2')
    writeNativeChatDraftCache(scope, typedSince)
  })
  expect(hook.result.current.shown).toEqual([])
  return readNativeChatComposerDraft(scope).text
}

it('puts a refused reply back in an empty comment box', async () => {
  expect(await refusedReply('empty', '')).toBe('the internal ones')
})

it('keeps what the owner typed after sending', async () => {
  expect(await refusedReply('typed', 'something else')).toBe('something else')
})
