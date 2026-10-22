import { createIndexedDbNativeChatComposerDraftStorage } from './native-chat-composer-draft-indexeddb'
import type { NativeChatComposerDraftStorage } from './native-chat-composer-draft-storage'
import { createBrowserUuid } from '@/lib/browser-uuid'

export const TERMINAL_QUEUED_DRAFT_CLAIM_MS = 120_000

export type TerminalQueuedDraft = {
  id: string
  text: string
  imagePaths: string[]
  state: 'waiting' | 'editing' | 'sending' | 'unknown'
  claimedAt?: number
  claimId?: string
  editId?: string
}

export type TerminalQueuedDrafts = {
  messages: TerminalQueuedDraft[]
  paused: boolean
  awaitingTurn: boolean
  afterTurn: string | null
  afterTurnAt: number | null
}

const empty = (): TerminalQueuedDrafts => ({
  messages: [],
  paused: false,
  awaitingTurn: false,
  afterTurn: null,
  afterTurnAt: null
})

function readQueue(stored: unknown): TerminalQueuedDrafts {
  if (
    !stored ||
    typeof stored !== 'object' ||
    !('text' in stored) ||
    typeof stored.text !== 'string'
  ) {
    return empty()
  }
  const parsed: unknown = JSON.parse(stored.text)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('messages' in parsed) ||
    !Array.isArray(parsed.messages)
  ) {
    throw new Error('Invalid queued drafts')
  }
  const messages: TerminalQueuedDraft[] = []
  for (const value of parsed.messages) {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.id !== 'string' ||
      typeof value.text !== 'string' ||
      !Array.isArray(value.imagePaths) ||
      !value.imagePaths.every((path: unknown) => typeof path === 'string') ||
      !['waiting', 'editing', 'sending', 'unknown'].includes(value.state) ||
      (value.claimedAt !== undefined &&
        (typeof value.claimedAt !== 'number' || !Number.isFinite(value.claimedAt))) ||
      (value.claimId !== undefined && typeof value.claimId !== 'string') ||
      (value.editId !== undefined && typeof value.editId !== 'string')
    ) {
      throw new Error('Invalid queued draft')
    }
    messages.push({
      id: value.id,
      text: value.text,
      imagePaths: value.imagePaths,
      state: value.state,
      ...(value.claimedAt !== undefined ? { claimedAt: value.claimedAt } : {}),
      ...(value.claimId !== undefined ? { claimId: value.claimId } : {}),
      ...(value.editId !== undefined ? { editId: value.editId } : {})
    })
  }
  return {
    messages,
    paused: 'paused' in parsed && parsed.paused === true,
    awaitingTurn: 'awaitingTurn' in parsed && parsed.awaitingTurn === true,
    afterTurnAt:
      'afterTurnAt' in parsed &&
      typeof parsed.afterTurnAt === 'number' &&
      Number.isFinite(parsed.afterTurnAt)
        ? parsed.afterTurnAt
        : null,
    afterTurn:
      'afterTurn' in parsed && typeof parsed.afterTurn === 'string' ? parsed.afterTurn : null
  }
}

/** The same transactional draft storage, in a separate database from the composer's one draft. */
export class NativeChatTerminalQueuedDrafts {
  constructor(private readonly storage: NativeChatComposerDraftStorage) {}

  async read(scope: string): Promise<TerminalQueuedDrafts> {
    return readQueue(await this.storage.read(scope))
  }

  async recover(scope: string, now = Date.now()): Promise<TerminalQueuedDrafts> {
    return this.change(scope, (queue) => {
      for (const message of queue.messages) {
        if (
          message.state === 'sending' &&
          now >= (message.claimedAt ?? 0) + TERMINAL_QUEUED_DRAFT_CLAIM_MS
        ) {
          message.state = 'unknown'
          queue.paused = true
        }
      }
    })
  }

  async settle(
    scope: string,
    draft: TerminalQueuedDraft,
    accepted: boolean,
    afterTurn: string | null,
    afterTurnAt: number | null
  ): Promise<TerminalQueuedDrafts> {
    return this.change(scope, (queue) => {
      const message = queue.messages.find((message) => message.id === draft.id)
      if (!message || message.claimId !== draft.claimId) {
        return
      }
      if (accepted) {
        queue.messages = queue.messages.filter((message) => message.id !== draft.id)
        queue.awaitingTurn = true
        queue.afterTurn = afterTurn
        queue.afterTurnAt = afterTurnAt
      } else {
        message.state = 'unknown'
        queue.paused = true
      }
    })
  }

  async change(
    scope: string,
    apply: (queue: TerminalQueuedDrafts) => void
  ): Promise<TerminalQueuedDrafts> {
    let result = empty()
    await this.storage.update(scope, (stored) => {
      result = readQueue(stored)
      apply(result)
      return { text: JSON.stringify(result), images: [], savedAt: Date.now() }
    })
    return result
  }

  async claim(
    scope: string,
    messageId: string,
    explicit: boolean
  ): Promise<TerminalQueuedDraft | null> {
    let claimed: TerminalQueuedDraft | null = null
    await this.change(scope, (queue) => {
      if (queue.messages.some((message) => message.state !== 'waiting')) {
        return
      }
      if (!explicit && (queue.paused || queue.awaitingTurn)) {
        return
      }
      const message = queue.messages.find((message) => message.id === messageId)
      if (!message) {
        return
      }
      message.state = 'sending'
      message.claimedAt = Date.now()
      message.claimId = createBrowserUuid()
      claimed = { ...message }
    })
    return claimed
  }
}

let storage: NativeChatTerminalQueuedDrafts | undefined
export function terminalQueuedDrafts(): NativeChatTerminalQueuedDrafts {
  storage ??= new NativeChatTerminalQueuedDrafts(
    createIndexedDbNativeChatComposerDraftStorage(
      indexedDB,
      'orca-native-chat-terminal-queued-drafts'
    )
  )
  return storage
}
