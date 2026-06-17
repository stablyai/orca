import type {
  GlobalSettings,
  TrelloAttachment,
  TrelloBoard,
  TrelloCard,
  TrelloCardFilter,
  TrelloCardUpdate,
  TrelloComment,
  TrelloConnectionStatus,
  TrelloCreateCardArgs,
  TrelloImageDownloadResult,
  TrelloUploadAttachmentArgs,
  TrelloLabel,
  TrelloList,
  TrelloMember,
  TrelloViewer
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  downloadTrelloImageThroughRuntime,
  uploadTrelloAttachmentThroughRuntime
} from './runtime-trello-chunked-transfer'

export type RuntimeTrelloSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | null
  | undefined
export type TrelloConnectResult = { ok: true; viewer: TrelloViewer } | { ok: false; error: string }
export type TrelloCommentResult = { ok: true; id: string } | { ok: false; error: string }

export async function trelloStatus(
  settings: RuntimeTrelloSettings
): Promise<TrelloConnectionStatus> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloConnectionStatus>(target, 'trello.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.trello.status()
}

export async function trelloConnect(
  settings: RuntimeTrelloSettings,
  args: { apiKey: string; token: string }
): Promise<TrelloConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloConnectResult>(target, 'trello.connect', args, { timeoutMs: 30_000 })
    : window.api.trello.connect(args)
}

export async function trelloDisconnect(settings: RuntimeTrelloSettings): Promise<void> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(target, 'trello.disconnect', undefined, {
      timeoutMs: 15_000
    })
    return
  }
  await window.api.trello.disconnect()
}

export async function trelloTestConnection(
  settings: RuntimeTrelloSettings
): Promise<TrelloConnectResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloConnectResult>(target, 'trello.testConnection', undefined, {
        timeoutMs: 30_000
      })
    : window.api.trello.testConnection()
}

export async function trelloListBoards(settings: RuntimeTrelloSettings): Promise<TrelloBoard[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloBoard[]>(target, 'trello.listBoards', undefined, { timeoutMs: 30_000 })
    : window.api.trello.listBoards()
}

export async function trelloListLists(
  settings: RuntimeTrelloSettings,
  boardId: string
): Promise<TrelloList[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloList[]>(target, 'trello.listLists', { boardId }, { timeoutMs: 30_000 })
    : window.api.trello.listLists({ boardId })
}

export async function trelloListBoardMembers(
  settings: RuntimeTrelloSettings,
  boardId: string
): Promise<TrelloMember[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloMember[]>(
        target,
        'trello.listBoardMembers',
        { boardId },
        { timeoutMs: 30_000 }
      )
    : window.api.trello.listBoardMembers({ boardId })
}

export async function trelloListBoardLabels(
  settings: RuntimeTrelloSettings,
  boardId: string
): Promise<TrelloLabel[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloLabel[]>(
        target,
        'trello.listBoardLabels',
        { boardId },
        { timeoutMs: 30_000 }
      )
    : window.api.trello.listBoardLabels({ boardId })
}

export async function trelloListCards(
  settings: RuntimeTrelloSettings,
  filter?: TrelloCardFilter,
  limit?: number,
  boardIds?: string[]
): Promise<TrelloCard[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { filter, limit, boardIds }
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloCard[]>(target, 'trello.listCards', args, { timeoutMs: 30_000 })
    : window.api.trello.listCards(args)
}

export async function trelloSearchCards(
  settings: RuntimeTrelloSettings,
  query: string,
  limit?: number,
  boardIds?: string[]
): Promise<TrelloCard[]> {
  const target = getActiveRuntimeTarget(settings)
  const args = { query, limit, boardIds }
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloCard[]>(target, 'trello.searchCards', args, { timeoutMs: 30_000 })
    : window.api.trello.searchCards(args)
}

export async function trelloGetCard(
  settings: RuntimeTrelloSettings,
  cardId: string
): Promise<TrelloCard | null> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloCard | null>(target, 'trello.getCard', { cardId }, { timeoutMs: 30_000 })
    : window.api.trello.getCard({ cardId })
}

export async function trelloCreateCard(
  settings: RuntimeTrelloSettings,
  args: TrelloCreateCardArgs
): Promise<
  { ok: true; id: string; shortLink: string; url: string } | { ok: false; error: string }
> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<
        { ok: true; id: string; shortLink: string; url: string } | { ok: false; error: string }
      >(target, 'trello.createCard', args, { timeoutMs: 30_000 })
    : window.api.trello.createCard(args)
}

export async function trelloUpdateCard(
  settings: RuntimeTrelloSettings,
  cardId: string,
  updates: TrelloCardUpdate
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<{ ok: true } | { ok: false; error: string }>(
        target,
        'trello.updateCard',
        { cardId, updates },
        { timeoutMs: 30_000 }
      )
    : window.api.trello.updateCard({ cardId, updates })
}

export async function trelloAddCardComment(
  settings: RuntimeTrelloSettings,
  cardId: string,
  text: string
): Promise<TrelloCommentResult> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloCommentResult>(
        target,
        'trello.addCardComment',
        { cardId, text },
        { timeoutMs: 30_000 }
      )
    : window.api.trello.addCardComment({ cardId, text })
}

export async function trelloCardComments(
  settings: RuntimeTrelloSettings,
  cardId: string
): Promise<TrelloComment[]> {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<TrelloComment[]>(
        target,
        'trello.cardComments',
        { cardId },
        { timeoutMs: 30_000 }
      )
    : window.api.trello.cardComments({ cardId })
}

export async function trelloUploadAttachment(
  settings: RuntimeTrelloSettings,
  args: TrelloUploadAttachmentArgs
): Promise<{ ok: true; attachment: TrelloAttachment } | { ok: false; error: string }> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.trello.uploadAttachment(args)
  }
  return uploadTrelloAttachmentThroughRuntime(target, args)
}

export async function trelloDownloadImage(
  settings: RuntimeTrelloSettings,
  url: string
): Promise<TrelloImageDownloadResult> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return window.api.trello.downloadImage({ url })
  }
  return downloadTrelloImageThroughRuntime(target, url)
}
