import type {
  BusinessmapBoard,
  BusinessmapCard,
  BusinessmapCardFilter,
  BusinessmapCardUpdate,
  BusinessmapComment,
  BusinessmapConnectArgs,
  BusinessmapConnectionStatus,
  BusinessmapCreateCardArgs,
  BusinessmapCreateCardResult,
  BusinessmapMutationResult,
  BusinessmapViewer
} from '../../../shared/businessmap-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import {
  getBusinessmapRuntimeTarget,
  type RuntimeBusinessmapSettings
} from './runtime-businessmap-target'

export type { RuntimeBusinessmapSettings } from './runtime-businessmap-target'

export type BusinessmapConnectResult =
  | { ok: true; viewer: BusinessmapViewer }
  | { ok: false; error: string }
export type BusinessmapCommentResult = { ok: true; id: number } | { ok: false; error: string }

export async function businessmapStatus(
  settings: RuntimeBusinessmapSettings
): Promise<BusinessmapConnectionStatus> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapConnectionStatus>(target, 'businessmap.status', undefined, {
        timeoutMs: 15_000
      })
    : window.api.businessmap.status()
}

export async function businessmapReadStatus(
  settings: RuntimeBusinessmapSettings
): Promise<BusinessmapConnectionStatus> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapConnectionStatus>(target, 'businessmap.readStatus', undefined, {
        timeoutMs: 15_000
      })
    : window.api.businessmap.readStatus()
}

export async function businessmapConnect(
  settings: RuntimeBusinessmapSettings,
  args: BusinessmapConnectArgs
): Promise<BusinessmapConnectResult> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapConnectResult>(target, 'businessmap.connect', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.connect(args)
}

export async function businessmapDisconnect(
  settings: RuntimeBusinessmapSettings,
  siteId?: string | null
): Promise<void> {
  const target = getBusinessmapRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(
      target,
      'businessmap.disconnect',
      siteId ? { siteId } : undefined,
      { timeoutMs: 15_000 }
    )
    return
  }
  await window.api.businessmap.disconnect(siteId ? { siteId } : undefined)
}

export async function businessmapSelectSite(
  settings: RuntimeBusinessmapSettings,
  siteId: string
): Promise<BusinessmapConnectionStatus> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapConnectionStatus>(
        target,
        'businessmap.selectSite',
        { siteId },
        { timeoutMs: 15_000 }
      )
    : window.api.businessmap.selectSite({ siteId })
}

export async function businessmapTestConnection(
  settings: RuntimeBusinessmapSettings,
  siteId?: string | null
): Promise<BusinessmapConnectResult> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapConnectResult>(
        target,
        'businessmap.testConnection',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.businessmap.testConnection(siteId ? { siteId } : undefined)
}

export async function businessmapSearchCards(
  settings: RuntimeBusinessmapSettings,
  query: string,
  limit?: number,
  siteId?: string | null,
  boardId?: number | null,
  signal?: AbortSignal
): Promise<BusinessmapCard[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  if (signal?.aborted) {
    throw createBusinessmapAbortError('search')
  }
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { query, limit, siteId: siteId ?? undefined, boardId: boardId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapCard[]>(target, 'businessmap.searchCards', args, {
        timeoutMs: 30_000,
        signal
      })
    : window.api.businessmap.searchCards(args)
}

export async function businessmapListCards(
  settings: RuntimeBusinessmapSettings,
  filter?: BusinessmapCardFilter,
  limit?: number,
  siteId?: string | null,
  boardId?: number | null
): Promise<BusinessmapCard[]> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = {
    filter,
    limit,
    siteId: siteId ?? undefined,
    boardId: boardId ?? undefined
  }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapCard[]>(target, 'businessmap.listCards', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.listCards(args)
}

export async function businessmapGetCard(
  settings: RuntimeBusinessmapSettings,
  id: number,
  siteId?: string | null
): Promise<BusinessmapCard | null> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { id, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapCard | null>(target, 'businessmap.getCard', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.getCard(args)
}

export async function businessmapCreateCard(
  settings: RuntimeBusinessmapSettings,
  args: BusinessmapCreateCardArgs,
  siteId?: string | null
): Promise<BusinessmapCreateCardResult> {
  const target = getBusinessmapRuntimeTarget(settings)
  const payload = { ...args, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapCreateCardResult>(target, 'businessmap.createCard', payload, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.createCard(payload)
}

export async function businessmapUpdateCard(
  settings: RuntimeBusinessmapSettings,
  id: number,
  updates: BusinessmapCardUpdate,
  siteId?: string | null
): Promise<BusinessmapMutationResult> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { id, updates, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapMutationResult>(target, 'businessmap.updateCard', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.updateCard(args)
}

export async function businessmapAddCardComment(
  settings: RuntimeBusinessmapSettings,
  id: number,
  body: string,
  siteId?: string | null
): Promise<BusinessmapCommentResult> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { id, body, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapCommentResult>(target, 'businessmap.addCardComment', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.addCardComment(args)
}

export async function businessmapIssueComments(
  settings: RuntimeBusinessmapSettings,
  id: number,
  siteId?: string | null
): Promise<BusinessmapComment[]> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { id, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapComment[]>(target, 'businessmap.issueComments', args, {
        timeoutMs: 30_000
      })
    : window.api.businessmap.issueComments(args)
}

export async function businessmapListBoards(
  settings: RuntimeBusinessmapSettings,
  siteId?: string | null
): Promise<BusinessmapBoard[]> {
  const target = getBusinessmapRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<BusinessmapBoard[]>(
        target,
        'businessmap.listBoards',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.businessmap.listBoards(siteId ? { siteId } : undefined)
}

export async function businessmapGetBoardTree(
  settings: RuntimeBusinessmapSettings,
  boardId: number,
  siteId?: string | null
): Promise<unknown> {
  const target = getBusinessmapRuntimeTarget(settings)
  const args = { boardId, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<unknown>(target, 'businessmap.getBoardTree', args, { timeoutMs: 30_000 })
    : window.api.businessmap.getBoardTree(args)
}

function createBusinessmapAbortError(what: string): Error {
  const error = new Error(`Businessmap ${what} aborted`)
  error.name = 'AbortError'
  return error
}
