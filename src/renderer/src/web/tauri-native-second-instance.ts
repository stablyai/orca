import type { MarkdownDocument } from '../../../shared/file-listing/file-document'
import { skillShareIdFromArguments } from '../../../shared/skills/sharing/skill-share-link'
import type { PreloadApi } from '../../../preload/api-types'
import { invokeNative, listenNative } from './tauri-native-host'

const EVENT_SECOND_INSTANCE = 'app:second-instance'

type SecondInstancePayload = {
  id: number
  args: string[]
  cwd: string
}

type SkillShareListener = (shareId: string) => void
type MarkdownDocumentsListener = (documents: MarkdownDocument[]) => void

type SecondInstanceBridge = Pick<
  NonNullable<PreloadApi['ui']>,
  | 'onOpenSkillShare'
  | 'consumePendingSkillShare'
  | 'onOpenMarkdownFiles'
  | 'consumePendingMarkdownFileOpens'
>

export function createTauriNativeSecondInstanceBridge(): SecondInstanceBridge {
  const skillShareListeners = new Set<SkillShareListener>()
  const markdownListeners = new Set<MarkdownDocumentsListener>()
  const pendingSkillShares: string[] = []
  const pendingMarkdownDocuments: MarkdownDocument[][] = []
  const seenPayloads = new Set<number>()

  const publishSkillShare = (shareId: string): void => {
    if (skillShareListeners.size === 0) {
      pendingSkillShares.push(shareId)
      return
    }
    for (const listener of skillShareListeners) {
      listener(shareId)
    }
  }

  const publishMarkdownDocuments = (documents: MarkdownDocument[]): void => {
    if (documents.length === 0) {
      return
    }
    if (markdownListeners.size === 0) {
      pendingMarkdownDocuments.push(documents)
      return
    }
    for (const listener of markdownListeners) {
      listener(documents)
    }
  }

  const acceptPayload = (payload: SecondInstancePayload): void => {
    if (!Number.isSafeInteger(payload.id) || seenPayloads.has(payload.id)) {
      return
    }
    seenPayloads.add(payload.id)
    const shareId = skillShareIdFromArguments(payload.args)
    if (shareId) {
      publishSkillShare(shareId)
    }
    void invokeNative<MarkdownDocument[]>('poc_resolve_opened_documents', {
      paths: payload.args
    })
      .then(publishMarkdownDocuments)
      .catch(() => {})
  }

  listenNative<SecondInstancePayload>(EVENT_SECOND_INSTANCE, acceptPayload)
  void invokeNative<SecondInstancePayload[]>('poc_consume_second_instance_events')
    .then((payloads) => {
      if (Array.isArray(payloads)) {
        for (const payload of payloads) {
          acceptPayload(payload)
        }
      }
    })
    .catch(() => {})

  return {
    onOpenSkillShare: (listener) => {
      skillShareListeners.add(listener)
      return () => skillShareListeners.delete(listener)
    },
    consumePendingSkillShare: () => Promise.resolve(pendingSkillShares.shift() ?? null),
    onOpenMarkdownFiles: (listener) => {
      markdownListeners.add(listener)
      return () => markdownListeners.delete(listener)
    },
    consumePendingMarkdownFileOpens: () => Promise.resolve(pendingMarkdownDocuments.shift() ?? [])
  }
}
