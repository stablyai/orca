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

export const NATIVE_CHAT_MARKDOWN_IMAGE_ACCESS = chatImageAccess()

/** Protocol-relative sources load over the page's own web protocol. */
export function nativeChatMarkdownImageDisplaySrc(src: string): string {
  return src.startsWith('//') && /^https?:$/.test(window.location.protocol)
    ? `${window.location.protocol}${src}`
    : src
}

/** A Markdown image's loadable source and its file-link target; loads only while `active` holds its lease. */
export function useNativeChatMarkdownImageSrc({
  src,
  active,
  retryKey
}: {
  src: string | undefined
  active: boolean
  retryKey: number
}) {
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
    src === undefined
      ? undefined
      : route.kind === 'file'
        ? createNativeChatFileHref(route.pathText, 'literal')
        : src
  const external = Boolean(src && /^(?:https?|data|blob):/i.test(src))
  const attachment = src ? jiraImageReference(src) !== null : false
  const media = useNativeChatMediaHref({
    href: originalImageHref,
    runtimeContext,
    tabId: fileLinkContext?.sourceTabId,
    sessionId: owner?.sessionId,
    active,
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
    active ? localSrc : undefined,
    target?.absolutePath ?? '',
    runtimeContext?.connectionId,
    imageRuntimeContext,
    NATIVE_CHAT_MARKDOWN_IMAGE_ACCESS,
    retryKey
  )
  return {
    imageSrc: external || attachment ? src : active ? loadedSrc : undefined,
    imageHref,
    target,
    route,
    fileLinkContext
  }
}
