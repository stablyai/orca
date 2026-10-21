import { useEffect, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  acquireJiraImageUrl,
  hasCachedJiraImage,
  onJiraImageCacheInvalidated
} from '@/runtime/runtime-jira-image-cache'
import { jiraImageProtocolUrl } from '@/runtime/runtime-jira-image-client'
import { translate } from '@/i18n/i18n'
import { ExpandableMarkdownImage } from './sidebar/MarkdownImageLightbox'

type JiraAttachmentImageProps = {
  target: RuntimeClientTarget
  reference: string
  alt?: string
  compact: boolean
}

export function JiraAttachmentImage(props: JiraAttachmentImageProps): React.JSX.Element {
  const owner = props.target.kind === 'environment' ? props.target.environmentId : 'local'
  return <ResolvedJiraAttachmentImage key={`${owner}:${props.reference}`} {...props} />
}

function ResolvedJiraAttachmentImage({
  target,
  reference,
  alt,
  compact
}: JiraAttachmentImageProps): React.JSX.Element {
  const [resolved, setResolved] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [generation, setGeneration] = useState(0)
  const activeRequest = useRef<AbortController | null>(null)
  const localProtocol = target.kind === 'local' && !hasCachedJiraImage(target, reference)
  const src = localProtocol ? jiraImageProtocolUrl(reference) : resolved
  useEffect(
    () =>
      onJiraImageCacheInvalidated((environmentId) => {
        if (
          environmentId === null ||
          (target.kind === 'environment' && environmentId === target.environmentId)
        ) {
          activeRequest.current?.abort()
          setResolved(null)
          setFailed(false)
          setGeneration((value) => value + 1)
        }
      }),
    [target]
  )
  useEffect(() => {
    if (localProtocol) {
      return
    }
    const controller = new AbortController()
    activeRequest.current = controller
    let release: (() => void) | undefined
    void acquireJiraImageUrl(target, reference, controller.signal)
      .then((image) => {
        if (controller.signal.aborted) {
          image.release()
          return
        }
        release = image.release
        setResolved(image.url)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true)
        }
      })
    return () => {
      controller.abort()
      if (activeRequest.current === controller) {
        activeRequest.current = null
      }
      release?.()
    }
  }, [generation, localProtocol, reference, target])
  if (!src || failed) {
    return (
      <span>
        {alt || translate('auto.components.sidebar.MarkdownImageLightbox.image', 'Image')}
      </span>
    )
  }
  return (
    <ExpandableMarkdownImage
      key={generation}
      src={src}
      onError={() => setFailed(true)}
      alt={alt}
      triggerClassName={compact ? 'my-1' : undefined}
      className={
        compact
          ? 'max-h-32 max-w-full rounded-sm object-contain outline outline-1 outline-border/70'
          : 'max-h-96 max-w-full rounded-md object-contain outline outline-1 outline-border/70'
      }
    />
  )
}
