import { isRuntimePathAbsolute } from '../../file-access/cross-platform-path'
import { isRasterImagePath } from '../../file-preview/file-preview-kind'
import {
  isToolCallBlock,
  type NativeChatBlock,
  type NativeChatImageRefBlock,
  type NativeChatToolCallBlock
} from '../native-chat-types'
import { nativeChatToolCategory } from './native-chat-tool-icon'
import { nativeChatFullCommand } from './native-chat-tool-input-text'
import { nativeChatToolLineLabel } from './native-chat-tool-line-label'
import { pairToolBlocks } from './native-chat-tool-pairs'
import { toolFilePath } from './native-chat-tool-summary'

const NO_IMAGES: NativeChatImageRefBlock[] = []

/** The raster image a file-read tool names. A shell read (Codex's `cat x.png`) and an SVG read hand
 *  the agent text, not a picture; hosts read only absolute paths. */
function imageReadPath(call: NativeChatToolCallBlock): string | null {
  if (
    nativeChatToolCategory(call.name, call.mcpIdentity) !== 'read' ||
    nativeChatFullCommand(call.input) !== null
  ) {
    return null
  }
  const path = toolFilePath(call.input)
  return path !== null && isRuntimePathAbsolute(path) && isRasterImagePath(path) ? path : null
}

/** Prefer captured output per call; older reads still preview the image at their absolute path. */
export function nativeChatToolRunViewedImages(
  blocks: readonly NativeChatBlock[]
): NativeChatImageRefBlock[] {
  // Most runs read no images, so they skip pairing.
  if (
    !blocks.some(
      (block) =>
        isToolCallBlock(block) &&
        ((block.outputImages?.length ?? 0) > 0 || imageReadPath(block) !== null)
    )
  ) {
    return NO_IMAGES
  }
  const paths = new Set<string>()
  const images: NativeChatImageRefBlock[] = []
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call) {
      continue
    }
    // Publication appends an ellipsis to clipped strings; a data-URI prefix is not an image.
    const output = call.outputImages?.map((image): NativeChatImageRefBlock =>
      image.url?.startsWith('data:') && image.url.endsWith('…')
        ? { type: 'image-ref', alt: image.alt ?? 'Image preview unavailable' }
        : image
    )
    if (output?.some((image) => image.url || image.path)) {
      images.push(...output)
      continue
    }
    const path = imageReadPath(call)
    // Only a read that finished without error showed the agent its image.
    if (path !== null && nativeChatToolLineLabel(call, result).verb === 'read') {
      if (!paths.has(path)) {
        paths.add(path)
        images.push({ type: 'image-ref', path })
      }
    } else if (output?.length) {
      images.push(...output)
    }
  }
  return images
}
