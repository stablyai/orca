import { createContext, useContext, useLayoutEffect } from 'react'
import type { LocalFileAccess } from '../../../../../../../shared/file-access/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../../../../shared/native-chat/native-chat-types'

/** An attachment block, identified by the object itself so equal blocks stay distinct images. */
export type NativeChatGalleryBlock = Extract<NativeChatBlock, { type: 'image-ref' }>

/** The settled message an image belongs to. Null keeps pending, streaming and tool-run images out of
 *  a chat's image set: their ids or contents can still be replaced while a preview is open. */
export const NativeChatGalleryMessageContext = createContext<string | null>(null)

/** Null for rows that can still be replaced under the same id: a send or launch the echo replaces,
 *  and the agent's rows while its turn works, whose words and images may still be rewritten. */
export function nativeChatGalleryMessageId(
  message: NativeChatMessage,
  turnIsWorking?: boolean
): string | null {
  return message.id.startsWith('launch-pending:') ||
    message.pendingSend ||
    message.deliveryState ||
    message.unsent ||
    message.queued ||
    message.sentWhileStopping ||
    message.awaitsRetry ||
    (turnIsWorking === true && message.role !== 'user')
    ? null
    : message.id
}

/** Where focus goes when the list is covered (a subagent view) while its gallery had focus. */
export const NativeChatGalleryCoveredFocusContext = createContext<
  (() => HTMLElement | null) | null
>(null)

export type NativeChatGalleryImageSource =
  | { kind: 'url'; url: string }
  | {
      kind: 'local'
      rawSrc: string
      filePath: string
      connectionId?: string | null
      runtimeContext:
        | (Omit<RuntimeFileOperationArgs, 'connectionId'> & { connectionId?: string | null })
        | null
        | undefined
      access: LocalFileAccess
    }

/** How to show one image again, never a URL: a captured blob URL could already be due for revocation. */
export type NativeChatGalleryImage = {
  title: string
  source: NativeChatGalleryImageSource
  /** Markdown images offering File or Link actions; built from the chat's current owner when opened. */
  actions?: { href: string | undefined; isFile: boolean }
  /** An attachment's label, shown when its image cannot be. */
  label?: string
}

export type NativeChatGalleryRecord =
  | {
      kind: 'image'
      messageId: string
      near: boolean
      ready: boolean
      image: NativeChatGalleryImage
    }
  | {
      kind: 'group'
      messageId: string
      blocks: readonly NativeChatGalleryBlock[]
      images: readonly NativeChatGalleryImage[]
      /** Opens this block in the message's own viewer with notes, ready to annotate; false when its
       *  row is no longer mounted to take it. */
      annotate?: (block: NativeChatGalleryBlock) => boolean
    }

export type NativeChatGalleryController = {
  register: (element: Element, record: NativeChatGalleryRecord) => void
  /** Opens the chat's image set at this trigger; false keeps the producer's own preview. */
  tryOpen: (element: Element, block?: NativeChatGalleryBlock) => boolean
}

export const NativeChatGalleryControllerContext = createContext<NativeChatGalleryController | null>(
  null
)

export const NATIVE_CHAT_GALLERY_ITEM_ATTRIBUTE = 'data-native-chat-gallery-item'
export const NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE = 'data-native-chat-gallery-root'

/** Keeps this producer's record current; returns the controller only when it can join a set. */
export function useNativeChatGalleryRecord(
  element: React.RefObject<Element | null>,
  record: NativeChatGalleryRecord | null
): NativeChatGalleryController | null {
  const controller = useContext(NativeChatGalleryControllerContext)
  useLayoutEffect(() => {
    if (controller && record && element.current) {
      controller.register(element.current, record)
    }
  })
  return controller && record ? controller : null
}
