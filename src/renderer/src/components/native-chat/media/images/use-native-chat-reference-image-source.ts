import { useLocalImageSrc } from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import type { NativeChatImageRefBlock } from '../../../../../../shared/native-chat/native-chat-types'
const access = chatImageAccess()
export function nativeChatReferenceImageIsExternal(source: string | undefined): boolean {
  return Boolean(source && /^(?:https?|data|blob):/i.test(source))
}
export function useNativeChatReferenceImageSource(
  block: NativeChatImageRefBlock,
  runtime: RuntimeFileOperationArgs | null | undefined,
  active: boolean
): string | undefined {
  const source = block.url?.trim() || block.path
  const external = nativeChatReferenceImageIsExternal(source)
  const local = useLocalImageSrc(
    active && !external && runtime !== undefined ? source : undefined,
    block.path ?? source ?? '',
    runtime?.connectionId,
    runtime,
    access
  )
  return external && active ? source : local
}
