import {
  NATIVE_CHAT_GALLERY_ITEM_ATTRIBUTE,
  NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE,
  type NativeChatGalleryBlock,
  type NativeChatGalleryImage,
  type NativeChatGalleryRecord
} from './native-chat-image-gallery-context'

export type NativeChatGalleryEntry = {
  key: string
  messageId: string
  image: NativeChatGalleryImage
  /** The control that opens this image in the chat, for returning focus near it on close. */
  trigger: Element
}

export type NativeChatGalleryCapture = { entries: NativeChatGalleryEntry[]; index: number }

let nextEntryKey = 0

/** The images near the open chat, in transcript order, when they span more than one message. One
 *  message's images keep its own viewer; a lone image keeps the single preview. */
export function captureNativeChatGallery(
  root: Element,
  records: WeakMap<Element, NativeChatGalleryRecord>,
  clicked: Element,
  clickedBlock?: NativeChatGalleryBlock
): NativeChatGalleryCapture | null {
  const candidates: { element: Element; record: NativeChatGalleryRecord }[] = []
  for (const element of root.querySelectorAll(`[${NATIVE_CHAT_GALLERY_ITEM_ATTRIBUTE}]`)) {
    const record = records.get(element)
    // Cheap checks first; layout is read only for what could join.
    if (
      record &&
      (record.kind === 'image'
        ? record.near && record.ready
        : record.images.length > 0 && element.querySelector('button') !== null)
    ) {
      candidates.push({ element, record })
    }
  }
  const members = candidates.filter(
    ({ element }) =>
      element.closest(`[${NATIVE_CHAT_GALLERY_ROOT_ATTRIBUTE}]`) === root &&
      !element.closest('[inert],[hidden]') &&
      element.getClientRects().length > 0
  )
  const entries: NativeChatGalleryEntry[] = []
  let index = -1
  for (const { element, record } of members) {
    if (record.kind === 'image') {
      if (element === clicked) {
        index = entries.length
      }
      entries.push({
        key: `${nextEntryKey++}`,
        messageId: record.messageId,
        image: record.image,
        trigger: element
      })
      continue
    }
    const clickedAt = element === clicked && clickedBlock ? record.blocks.indexOf(clickedBlock) : -1
    record.images.forEach((image, at) => {
      if (at === clickedAt) {
        index = entries.length
      }
      entries.push({
        key: `${nextEntryKey++}`,
        messageId: record.messageId,
        image,
        trigger: element
      })
    })
  }
  const messages = new Set(entries.map(({ messageId }) => messageId))
  return index < 0 || entries.length < 2 || messages.size < 2 ? null : { entries, index }
}
