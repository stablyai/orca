import { expect, it } from 'vitest'
import {
  createBotItemPendingCommentsHook,
  type BotItemPendingCommentDelivery
} from './bot-item-pending-comments'
import { botItemRepliedAsks, isBotItemReplyingTo } from './bot-item-replying'

// The shared store, called outside React: one render's reads, as the page's hook gets them.
const pendingCommentsOutsideReact = createBotItemPendingCommentsHook({
  useEffect: () => {},
  useSyncExternalStore: (_subscribe, read) => read()
})

const held = (): Promise<never> => new Promise<never>(() => {})

function delivery(
  post: BotItemPendingCommentDelivery['post'],
  questionIds: boolean
): BotItemPendingCommentDelivery {
  return {
    post,
    failed: () => {},
    returnText: () => {},
    refresh: () => {},
    requestIds: true,
    questionIds,
    plain: true
  }
}

it('a reply still on its way to a replaced ask leaves the current ask open', () => {
  // The host doesn't take question ids: the wire carries none, the device still knows A.
  const store = delivery(held, false)
  pendingCommentsOutsideReact('stale', [], store).send('Yes', [], null, 'A')
  const [stale] = pendingCommentsOutsideReact('stale', [], store).shown
  expect(stale!.questionId).toBeNull()
  expect(isBotItemReplyingTo(stale!, 'B')).toBe(false)
  expect(isBotItemReplyingTo(stale!, 'A')).toBe(true)
})

it('a reply to the current ask answers it; a plain comment with the same words does not', () => {
  const store = delivery(held, true)
  pendingCommentsOutsideReact('current', [], store).send('Yes', [], null, 'B')
  pendingCommentsOutsideReact('current', [], store).send('Yes', [], null, undefined, true)
  const [reply, plain] = pendingCommentsOutsideReact('current', [], store).shown
  expect(isBotItemReplyingTo(reply!, 'B')).toBe(true)
  expect(isBotItemReplyingTo(plain!, 'B')).toBe(false)
})

it('a reply from an older path, with no ask known, still counts as answering', () => {
  const store = delivery(held, true)
  pendingCommentsOutsideReact('older', [], store).send('Yes', [], null)
  const [reply] = pendingCommentsOutsideReact('older', [], store).shown
  expect(isBotItemReplyingTo(reply!, 'B')).toBe(true)
})

it('a refused reply no longer answers anything', async () => {
  const refused = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('new question'), { code: 'item_changed' }))
  const store = delivery(refused, true)
  pendingCommentsOutsideReact('refused', [], store).send('Yes', [], null, 'A')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const shown = pendingCommentsOutsideReact('refused', [], store).shown
  expect(shown.every((entry) => !isBotItemReplyingTo(entry, 'A'))).toBe(true)
})

it('reads every reply on its way once, by the question each answers', () => {
  const store = delivery(held, false)
  const send = pendingCommentsOutsideReact('list', [], store).send
  send('Yes', [], null, 'A')
  send('Yes', [], null, undefined, true)
  expect(botItemRepliedAsks(pendingCommentsOutsideReact('list', [], store).shown)).toEqual({
    unknown: false,
    asks: new Set(['A'])
  })
  send('Maybe', [], null)
  expect(botItemRepliedAsks(pendingCommentsOutsideReact('list', [], store).shown).unknown).toBe(
    true
  )
})
