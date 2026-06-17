import type { GlobalSettings } from '../../../shared/types'
import { trelloUploadAttachment } from '@/runtime/runtime-trello-client'

const DATA_IMAGE_MARKDOWN = /!\[([^\]]*)\]\((data:(image\/[a-zA-Z0-9.+-]+);base64,([^\s)]+))\)/g
const BLOB_IMAGE_MARKDOWN = /!\[[^\]]*\]\(blob:[^)]+\)/

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}

function markdownEscapeAltText(value: string): string {
  return value.replace(/]/g, '\\]')
}

export async function prepareTrelloDescriptionForSave({
  cardId,
  description,
  settings
}: {
  cardId: string
  description: string
  settings: GlobalSettings | null | undefined
}): Promise<string> {
  if (BLOB_IMAGE_MARKDOWN.test(description)) {
    throw new Error('Save failed because the description contains an unsaved blob image.')
  }

  const matches = [...description.matchAll(DATA_IMAGE_MARKDOWN)]
  if (matches.length === 0) {
    return description
  }

  let prepared = description
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const fullMatch = match[0]
    const altText = match[1]
    const mimeType = match[3]
    const contentBase64 = match[4]
    const upload = await trelloUploadAttachment(settings, {
      cardId,
      name: `${altText || 'image'}-${index + 1}.${extensionForMimeType(mimeType)}`,
      mimeType,
      contentBase64
    })
    if (!upload.ok) {
      throw new Error(upload.error)
    }
    const replacement = `![${markdownEscapeAltText(altText)}](${upload.attachment.url})`
    prepared = prepared.replace(fullMatch, replacement)
  }

  return prepared
}
