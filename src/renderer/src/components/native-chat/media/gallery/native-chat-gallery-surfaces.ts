import type {
  NativeChatBlock,
  NativeChatImageRefBlock,
  NativeChatMessage
} from '../../../../../../shared/native-chat/native-chat-types'
import { nativeChatMessageDisplayBlocks } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-message-display-blocks'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeLook
} from '../../../../../../shared/native-chat/transcript/notices/native-chat-notice'
import { agentMessageTranscriptText } from '../../../../../../shared/agent-session/view/messages/agent-message-display-text'
import { nativeChatWorkRunEntries } from '../../../../../../shared/native-chat/transcript/folding/native-chat-work-run'
import { nativeChatAskRunBlocks } from '../../../../../../shared/native-chat/input/questions/native-chat-ask-row'
import { countToolCalls } from '../../../../../../shared/native-chat/tools/native-chat-tool-summary'
import { nativeChatToolRunViewedImageEntries } from '../../../../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { nativeChatToolRunAsidePositions } from '../../../../../../shared/native-chat/tools/native-chat-tool-run-aside-positions'

type SurfaceOwner = { ownerId: string; slotKey: string; role: string }
export type NativeChatGallerySurface = SurfaceOwner &
  (
    | { kind: 'files'; blocks: readonly NativeChatImageRefBlock[] }
    | {
        kind: 'document'
        text: string
        growing: boolean
        visuals: boolean
        allowFileUriLinks?: boolean
      }
  )

export type NativeChatGallerySlot = {
  message: NativeChatMessage
  workRun?: readonly NativeChatMessage[]
  drawsMessage: boolean
  receipt: boolean
  activeTurnIsWorking: boolean
  trailingRun: boolean
}

function files(
  ownerId: string,
  slotKey: string,
  role: string,
  blocks: readonly NativeChatBlock[]
): NativeChatGallerySurface {
  return {
    kind: 'files',
    ownerId,
    slotKey,
    role,
    blocks: blocks.filter((block) => block.type === 'image-ref')
  }
}

export function nativeChatReasoningImageSurface(
  message: Pick<NativeChatMessage, 'id' | 'blocks'>,
  slotKey = message.id,
  growing = false,
  allowFileUriLinks = false
): NativeChatGallerySurface {
  return {
    kind: 'document',
    ownerId: message.id,
    slotKey,
    role: 'reasoning-document',
    text: deriveNativeChatRowContent(message.blocks).markdown,
    growing,
    visuals: false,
    allowFileUriLinks
  }
}

export function nativeChatGallerySlotSurfaces(
  slot: NativeChatGallerySlot,
  options: { stoppedLabel: string; visuals: boolean; allowFileUriLinks?: boolean }
): NativeChatGallerySurface[] {
  if (!slot.drawsMessage || slot.receipt) {
    return []
  }
  const { message } = slot
  const blocks = nativeChatMessageDisplayBlocks(message, options.stoppedLabel)
  const content = deriveNativeChatRowContent(blocks)
  const slotKey = message.id
  const agentStart = Boolean(message.agentStart && message.from)
  const notice =
    !agentStart && message.role === 'system' ? nativeChatNoticeBlock(blocks) : undefined
  if (notice) {
    return nativeChatNoticeLook(notice).kind === 'plan'
      ? [
          {
            kind: 'document',
            ownerId: message.id,
            slotKey,
            role: 'plan-document',
            text: notice.text,
            growing: false,
            visuals: false,
            allowFileUriLinks: options.allowFileUriLinks
          }
        ]
      : []
  }
  if (!agentStart && blocks.some((block) => block.type === 'text' && block.providerFrame)) {
    return []
  }
  if (message.from && (agentStart || message.role === 'user')) {
    return [
      files(message.id, slotKey, 'agent-card-attachment', message.blocks),
      {
        kind: 'document',
        ownerId: message.id,
        slotKey,
        role: 'agent-card-document',
        text: agentMessageTranscriptText(message.blocks, message.from, message.shortened),
        growing: false,
        visuals: false,
        allowFileUriLinks: options.allowFileUriLinks
      }
    ]
  }
  if (message.role === 'reasoning' && slot.workRun === undefined) {
    return [nativeChatReasoningImageSurface(message, slotKey, false, options.allowFileUriLinks)]
  }
  const surfaces: NativeChatGallerySurface[] = [
    files(message.id, slotKey, 'row-attachment', content.prose)
  ]
  if (message.role !== 'reasoning') {
    surfaces.push({
      kind: 'document',
      ownerId: message.id,
      slotKey,
      role: 'row-document',
      text: content.markdown,
      growing:
        message.role === 'assistant' &&
        slot.activeTurnIsWorking &&
        slot.trailingRun &&
        message.blocks.at(-1)?.type === 'text',
      visuals: options.visuals && message.role === 'assistant',
      allowFileUriLinks: options.allowFileUriLinks
    })
  }
  if (message.role === 'user') {
    return surfaces
  }
  const run = slot.workRun ? nativeChatWorkRunEntries(slot.workRun) : undefined
  const runBlocks = run?.blocks ?? content.tools
  if (runBlocks.length === 0) {
    return surfaces
  }
  const { asks, work } = nativeChatAskRunBlocks(runBlocks)
  const blockOwners = new Map<NativeChatBlock, string>()
  for (const member of slot.workRun ?? [message]) {
    for (const block of member.blocks) {
      blockOwners.set(block, member.id)
    }
  }
  for (const { path, call } of nativeChatToolRunViewedImageEntries(work)) {
    surfaces.push(
      files(blockOwners.get(call) ?? message.id, slotKey, 'run-read', [{ type: 'image-ref', path }])
    )
  }
  if (run && (asks.length === 0 || countToolCalls(work) > 0)) {
    const positions = nativeChatToolRunAsidePositions(work, run.thoughtsBefore, run.thoughtsAfter)
    for (const thoughts of positions.values()) {
      for (const thought of thoughts) {
        surfaces.push(
          nativeChatReasoningImageSurface(thought, slotKey, false, options.allowFileUriLinks)
        )
      }
    }
  }
  return surfaces
}
