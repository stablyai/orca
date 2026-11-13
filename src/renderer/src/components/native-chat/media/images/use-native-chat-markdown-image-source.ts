import { useContext } from 'react'
import { useLocalImageSrc } from '@/components/editor/document-images/useLocalImageSrc'
import { chatImageAccess } from '@/lib/files/access/local-file-access'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { jiraImageReference } from '../../../../../../shared/jira/jira-attachment-image'
import { filesystemPathToFileUri } from '../../../../../../shared/file-links/file-uri-path'
import {
  createNativeChatFileHref,
  routeNativeChatHref
} from '../../../../../../shared/native-chat/native-chat-href-routing'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { resolveNativeChatFileLink } from '../../links/actions/native-chat-file-link'
import { useNativeChatMediaHref } from './use-native-chat-media-href'
const IMAGE_ACCESS = chatImageAccess()
export function useNativeChatMarkdownImageSource(
  src: string | undefined,
  leaseActive: boolean,
  retryKey = 0
) {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const runtimeContext = owner?.runtimeContext ?? null
  const fileLinkContext =
    runtimeContext?.worktreePath && owner?.fileLinkContext
      ? {
          ...owner.fileLinkContext,
          worktreeId: runtimeContext.worktreeId ?? owner.fileLinkContext.worktreeId,
          worktreePath: runtimeContext.worktreePath,
          runtimeEnvironmentId: runtimeTargetEnvironmentId(runtimeContext.target)
        }
      : null
  const route = routeNativeChatHref(src)
  const originalImageHref =
    route.kind === 'file' ? createNativeChatFileHref(route.pathText, 'literal') : src
  const external = Boolean(src && /^(?:https?|data|blob):/i.test(src))
  const attachment = src ? jiraImageReference(src) !== null : false
  const media = useNativeChatMediaHref({
    href: originalImageHref,
    runtimeContext,
    tabId: fileLinkContext?.sourceTabId,
    sessionId: owner?.sessionId,
    active: leaseActive,
    retryKey
  })
  const imageHref = media.href
  const imageRuntimeContext =
    runtimeContext && media.expectedEnvironmentPairingRevision !== undefined
      ? {
          ...runtimeContext,
          expectedEnvironmentPairingRevision: media.expectedEnvironmentPairingRevision
        }
      : runtimeContext
  const target = resolveNativeChatFileLink(imageHref, fileLinkContext)
  const localSrc =
    !external && !attachment && target ? filesystemPathToFileUri(target.absolutePath) : undefined
  const loadedSrc = useLocalImageSrc(
    leaseActive ? localSrc : undefined,
    target?.absolutePath ?? '',
    runtimeContext?.connectionId,
    imageRuntimeContext,
    IMAGE_ACCESS,
    retryKey
  )
  return {
    imageSrc: external || attachment ? src : leaseActive ? loadedSrc : undefined,
    fileLinkContext,
    route,
    imageHref,
    target
  }
}
