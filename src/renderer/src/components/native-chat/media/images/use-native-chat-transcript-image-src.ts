import type { NativeChatImageRefBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { useLocalImageSrc } from '../../../editor/document-images/useLocalImageSrc'
import type { RuntimeFileOperationArgs } from '../../../../runtime/files/runtime-file-client-types'
import { chatImageAccess } from '../../../../lib/files/access/local-file-access'

export function renderableNativeChatImageSource(source: string | undefined): boolean {
  return Boolean(source && /^(?:https?|data|blob):/i.test(source))
}

// Roles do not prove who chose an auto-loaded path; main must validate local images by real file type.
const TRANSCRIPT_IMAGE_ACCESS = chatImageAccess()

/** An attachment or tool image's displayable source; loads only while `active` holds its lease. */
export function useNativeChatTranscriptImageSrc(
  block: NativeChatImageRefBlock | undefined,
  runtimeContext: RuntimeFileOperationArgs | null | undefined,
  active: boolean
): { source: string | undefined; external: boolean; displaySrc: string | undefined } {
  const source = block ? block.url?.trim() || block.path : undefined
  const filePath = block?.path ?? source ?? ''
  const external = renderableNativeChatImageSource(source)
  const localSrc = useLocalImageSrc(
    active && !external && runtimeContext !== undefined ? source : undefined,
    filePath,
    runtimeContext?.connectionId,
    runtimeContext,
    TRANSCRIPT_IMAGE_ACCESS
  )
  return { source, external, displaySrc: external && active ? source : localSrc }
}
