import { isRuntimePathAbsolute } from '../../cross-platform-path'
import { isRasterImagePath } from '../../file-preview-kind'
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

/** Image files a run's tools read; their results hold only the bytes, so each call's path names its image. */
export function nativeChatToolRunViewedImages(
  blocks: readonly NativeChatBlock[]
): NativeChatImageRefBlock[] {
  // Most runs read no images, so they skip pairing.
  if (!blocks.some((block) => isToolCallBlock(block) && imageReadPath(block) !== null)) {
    return NO_IMAGES
  }
  const paths = new Set<string>()
  for (const { call, result } of pairToolBlocks(blocks)) {
    const path = call ? imageReadPath(call) : null
    // Only a read that finished without error showed the agent its image.
    if (call && path !== null && nativeChatToolLineLabel(call, result).verb === 'read') {
      paths.add(path)
    }
  }
  return Array.from(paths, (path) => ({ type: 'image-ref', path }))
}
