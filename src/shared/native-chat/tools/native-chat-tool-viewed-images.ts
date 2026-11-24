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
export function nativeChatToolImageReadPath(
  call: Pick<NativeChatToolCallBlock, 'name' | 'input' | 'mcpIdentity'>
): string | null {
  if (
    nativeChatToolCategory(call.name, call.mcpIdentity) !== 'read' ||
    nativeChatFullCommand(call.input) !== null
  ) {
    return null
  }
  const path = toolFilePath(call.input)
  return path !== null && isRuntimePathAbsolute(path) && isRasterImagePath(path) ? path : null
}

/** Images a run's tools showed the agent: the raster file a successful read names, else what a call returned. */
export function nativeChatToolRunViewedImages(
  blocks: readonly NativeChatBlock[]
): NativeChatImageRefBlock[] {
  // Most runs show no images, so they skip pairing.
  if (
    !blocks.some(
      (block) =>
        isToolCallBlock(block) &&
        (Boolean(block.outputImagePaths?.length) || nativeChatToolImageReadPath(block) !== null)
    )
  ) {
    return NO_IMAGES
  }
  const paths = new Set<string>()
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call) {
      continue
    }
    const path = nativeChatToolImageReadPath(call)
    if (path === null) {
      call.outputImagePaths?.forEach((stored) => paths.add(stored))
    } else if (nativeChatToolLineLabel(call, result).verb === 'read') {
      // Only a read that finished without error showed the agent its image.
      paths.add(path)
    }
  }
  return Array.from(paths, (path) => ({ type: 'image-ref', path }))
}
