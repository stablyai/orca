import { normalizeRuntimePathForComparison } from '../../../cross-platform-path'
import { routeNativeChatHref } from '../../native-chat-href-routing'
import {
  isGeneratedImageOperation,
  NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION
} from '../../native-chat-generated-image'
import type { NativeChatBlock, NativeChatMessage } from '../../native-chat-types'
import { nativeChatTurnFoldRow } from '../folding/native-chat-turn-fold'

type Image = Extract<NativeChatBlock, { type: 'image-ref' }>
export type NativeChatMarkdownImageSources = (message: NativeChatMessage) => readonly string[]
type Segment = { images: number[]; answer: number | undefined }

const stripped = new WeakMap<NativeChatMessage, NativeChatMessage>()
const projected = new WeakMap<
  NativeChatMessage,
  {
    images: readonly Image[]
    sources: NativeChatMarkdownImageSources
    synthetic: boolean
    message: NativeChatMessage
  }
>()

function imageKey(image: Image): string {
  return image.path !== undefined
    ? `path:${normalizeRuntimePathForComparison(image.path)}`
    : `url:${image.url ?? ''}`
}

function markdownImageKey(source: string): string {
  const route = routeNativeChatHref(source)
  return route.kind === 'file'
    ? `path:${normalizeRuntimePathForComparison(route.pathText)}`
    : `url:${source}`
}

function withoutGeneratedPreview(message: NativeChatMessage): NativeChatMessage {
  let result = stripped.get(message)
  if (!result) {
    result = { ...message, blocks: message.blocks.filter((block) => block.type !== 'image-ref') }
    stripped.set(message, result)
  }
  return result
}

function answerWithImages(
  answer: NativeChatMessage,
  images: readonly Image[],
  sources: NativeChatMarkdownImageSources,
  synthetic: boolean
): NativeChatMessage {
  const cached = projected.get(answer)
  if (
    cached &&
    cached.synthetic === synthetic &&
    cached.sources === sources &&
    cached.images.length === images.length &&
    cached.images.every((image, i) => image === images[i])
  ) {
    return cached.message
  }
  const blocks = synthetic
    ? answer.blocks.filter(
        (block) => block.type !== 'image-ref' && !isGeneratedImageOperation(block)
      )
    : answer.blocks
  const shown = new Set([
    ...blocks.filter((block): block is Image => block.type === 'image-ref').map(imageKey),
    ...sources(answer).map(markdownImageKey)
  ])
  const missing = images.filter((image) => {
    const key = imageKey(image)
    if (shown.has(key)) {
      return false
    }
    shown.add(key)
    return true
  })
  const message =
    !synthetic && missing.length === 0
      ? answer
      : {
          ...answer,
          blocks: [
            ...blocks,
            ...(synthetic
              ? [
                  {
                    type: 'text' as const,
                    text: '',
                    presentation: NATIVE_CHAT_GENERATED_IMAGE_PRESENTATION
                  }
                ]
              : []),
            ...missing
          ]
        }
  projected.set(answer, { images, sources, synthetic, message })
  return message
}

/** Project completed output into its answer without rewriting the journal or moving viewed inputs. */
export function nativeChatGeneratedImageAnswers(
  messages: readonly NativeChatMessage[],
  turnKeys: readonly (string | undefined)[],
  settledTurnKeys: ReadonlySet<string>,
  sources: NativeChatMarkdownImageSources
): readonly NativeChatMessage[] {
  let result: NativeChatMessage[] | undefined
  const turns = new Map<string, Map<string | undefined, Segment>>()
  const finish = (segment: Segment) => {
    const lastImage = segment.images.at(-1)
    if (lastImage === undefined) {
      return
    }
    const answer = segment.answer === undefined ? undefined : messages[segment.answer]
    const synthetic = answer?.role !== 'assistant'
    const target = synthetic ? lastImage : segment.answer!
    const images = segment.images.flatMap((index) =>
      messages[index]!.blocks.filter((block): block is Image => block.type === 'image-ref')
    )
    result ??= [...messages]
    for (const index of segment.images) {
      result[index] = withoutGeneratedPreview(messages[index]!)
    }
    result[target] = answerWithImages(messages[target]!, images, sources, synthetic)
  }
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    if (turnKey === undefined || !settledTurnKeys.has(turnKey)) {
      continue
    }
    let producers = turns.get(turnKey)
    if (!producers) {
      producers = new Map()
      turns.set(turnKey, producers)
    }
    let segment = producers.get(message.agentId)
    if (!segment) {
      segment = { images: [], answer: undefined }
      producers.set(message.agentId, segment)
    }
    const facts = nativeChatTurnFoldRow(message, turnKey, false)
    if (facts.sendsBack) {
      finish(segment)
      segment = { images: [], answer: undefined }
      producers.set(message.agentId, segment)
    }
    if (
      message.role === 'assistant' &&
      message.blocks.some(isGeneratedImageOperation) &&
      message.blocks.some((block) => block.type === 'image-ref')
    ) {
      segment.images.push(index)
    } else if (
      facts.rendersProse &&
      !facts.outlivesTurn &&
      !facts.explainsTurn &&
      (message.role === 'assistant' || (message.role === 'system' && facts.reportsFailure))
    ) {
      segment.answer = index
    }
  }
  for (const producers of turns.values()) {
    for (const segment of producers.values()) {
      finish(segment)
    }
  }
  return result ?? messages
}
