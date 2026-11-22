import { nativeChatPendingContentKey } from './native-chat-pending-content-key'
import type { NativeChatPendingOccurrence } from './native-chat-pending-occurrence'
import { readAgentImageSourceContext } from '../../input/composer/agent-image-paste'
import { unwrapClaudePastedContent } from '../../../agent-hook-listener/providers/claude/transcripts/claude-pasted-content'
import { isImageRefBlock, isTextBlock, type NativeChatMessage } from '../../native-chat-types'
import { normalizeNativeChatUserText } from '../images/native-chat-image-transcript-markers'

export function pendingImagePrefixes(
  original: readonly string[] = [],
  delivered: readonly string[] = []
): string[] {
  return [original, delivered].flatMap((candidate) => {
    const normalized = candidate.filter(Boolean).map(normalizeNativeChatUserText)
    return [normalized.join(' '), normalized.join('')]
  })
}

const imageDeliveryRows = new WeakMap<
  NativeChatMessage['blocks'],
  {
    text: string
    literal: string
    paths: string[]
    rawPaths: (string | undefined)[]
    original: string[]
    prefixes: string[]
  }
>()

export function imageDeliveryRow(message: NativeChatMessage) {
  const cached = imageDeliveryRows.get(message.blocks)
  if (cached) {
    return cached
  }
  const text = message.blocks
    .filter(isTextBlock)
    .map((block) => unwrapClaudePastedContent(block.text))
    .join(' ')
  const candidate = readAgentImageSourceContext(text)
  const images = message.blocks.filter(isImageRefBlock)
  const textPrefix = normalizeNativeChatUserText(candidate.text)
  const deliveredPrefixes = pendingImagePrefixes([], candidate.delivered)
  const hasImageEvidence =
    (images.length === candidate.delivered.length &&
      images.length > 0 &&
      images.every((image, index) => !image.path || image.path === candidate.delivered[index])) ||
    (images.length === 0 &&
      deliveredPrefixes.some(
        (prefix) =>
          prefix.length > 0 && (textPrefix === prefix || textPrefix.startsWith(`${prefix} `))
      ))
  const context = hasImageEvidence ? candidate : { text, original: [], delivered: [] }
  const sources = new Map(context.delivered.map((path, index) => [path, context.original[index]]))
  const paths = message.blocks
    .filter(isImageRefBlock)
    .map((block) => block.path)
    .filter((path): path is string => Boolean(path))
    .map((path) => sources.get(path) ?? path)
  const row = {
    text: normalizeNativeChatUserText(context.text),
    literal: normalizeNativeChatUserText(text),
    paths,
    rawPaths: images.map((image) => image.path),
    original: context.original,
    prefixes: context.original.length
      ? pendingImagePrefixes(context.original, context.delivered)
      : []
  }
  imageDeliveryRows.set(message.blocks, row)
  return row
}

export function nativeChatUserMessageContentKey(
  message: NativeChatMessage,
  sentImagePaths: readonly string[] | undefined,
  deliveredImagePaths: readonly string[] | undefined,
  prefixes: readonly string[],
  literal: string,
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths' | 'images'>,
  literalKey: string
): string | null {
  if (message.role !== 'user') {
    return null
  }
  const row = imageDeliveryRow(message)
  const grouped = literalKey.includes('\0attachments:')
  const literalEligible = () => {
    if (!grouped) {
      return true
    }
    const paths = pending?.imagePaths?.filter(Boolean) ?? []
    const count = paths.length || pending?.images?.length || 0
    return (
      row.rawPaths.length === count &&
      row.rawPaths.every(
        (path, index) =>
          !path ||
          paths.length === 0 ||
          path === paths[index] ||
          path === deliveredImagePaths?.[index]
      )
    )
  }
  if (literal && row.literal === literal && literalEligible()) {
    return literalKey
  }
  let text = row.text
  const paths = sentImagePaths?.filter(Boolean) ?? []
  for (const prefix of row.prefixes.length ? row.prefixes : prefixes) {
    if (prefix && (text === prefix || text.startsWith(`${prefix} `))) {
      text = text.slice(prefix.length).trimStart()
      if (!text) {
        return nativeChatPendingContentKey({
          text: '',
          imagePaths: row.original.length ? row.original : paths
        })
      }
      break
    }
  }
  if (text) {
    if (grouped && text === literal) {
      const paths = pending?.imagePaths?.filter(Boolean) ?? []
      const deliveredEligible =
        row.original.length > 0 &&
        (paths.length > 0
          ? paths.length === row.original.length &&
            paths.every((path, index) => path === row.original[index])
          : pending.images?.length === row.original.length)
      return literalEligible() || deliveredEligible ? literalKey : null
    }
    return `text:${text}`
  }
  const imagePaths = row.original.length ? row.original : row.paths
  const matchesDelivered =
    deliveredImagePaths?.length === imagePaths.length &&
    imagePaths.every((path, index) => path === deliveredImagePaths[index])
  const key = nativeChatPendingContentKey({
    text: '',
    imagePaths: matchesDelivered ? paths : imagePaths
  })
  return key === 'empty' ? null : key
}
