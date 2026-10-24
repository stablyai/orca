import { useContext, useEffect, useRef, useState } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { toast } from 'sonner'
import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { fileArtifactSourceKey } from '@/lib/file-artifact-source-key'
import { openFileInBrowserTab } from '@/lib/file-preview'
import { basename } from '@/lib/path'
import { getRuntimeTargetHostId, runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { NATIVE_CHAT_VISUAL_RESERVED_HEIGHT, NativeChatVisualFrame } from './NativeChatVisualFrame'
import { observeTranscriptVisibility } from './NativeChatTranscriptChrome'
import { NativeChatForwardedGestureContext } from './native-chat-reader-scroll-input'
import type { NativeChatVisualOwner } from './native-chat-visual-owner'
import { readNativeChatVisual } from './native-chat-visual-read-client'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

export function NativeChatVisualUnavailable(): React.JSX.Element {
  return (
    <p className="my-2 text-xs text-chat-foreground-faint">
      {translate('components.native-chat.visualUnavailable', 'Visualization unavailable')}
    </p>
  )
}

/** Opens the visual like any HTML file of the chat's workspace: rendered, its source a click away. */
function openNativeChatVisualFile(worktreeId: string, path: string): void {
  const plan = openFileInBrowserTab({ filePath: path, worktreeId })
  if (plan.status === 'unsupported') {
    toast.error(plan.message)
  }
}

/** The file's own key on the chat's host, so Share here and on the opened file update one link. */
function nativeChatVisualShareKey(owner: NativeChatVisualOwner, path: string): string {
  return fileArtifactSourceKey(
    {
      executionHostId: getRuntimeTargetHostId(owner.target),
      runtimeEnvironmentId: runtimeTargetEnvironmentId(owner.target)
    },
    path
  )
}

/** Publishes the file as saved now, never the copy on screen; a failed read publishes nothing. */
async function readNativeChatVisualShareRequest(
  owner: NativeChatVisualOwner,
  file: string
): Promise<ArtifactWriteRequest> {
  const { target, sessionId } = owner
  const outcome = await readNativeChatVisual({ target, sessionId, file }, { fresh: true })
  if (!outcome.ok) {
    throw new ArtifactPublishPreparationError('visual-unreadable')
  }
  return {
    sourceKey: nativeChatVisualShareKey(owner, outcome.document.path),
    content: outcome.document.html,
    contentType: 'text/html',
    fileName: basename(outcome.document.path)
  }
}

/** Mount near the viewport, then keep the frame mounted so interactive state survives scrolling away. */
export function NativeChatInlineVisual({
  owner,
  file,
  title
}: {
  owner: NativeChatVisualOwner
  file: string
  title: string | null
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [near, setNear] = useState(false)
  const [retired, setRetired] = useState(false)
  // Share's popover is portalled, so hover and focus-within can't keep the toolbar shown.
  const [shareOpen, setShareOpen] = useState(false)
  const forwardGesture = useContext(NativeChatForwardedGestureContext)
  const state = useNativeChatVisualDocument(
    { target: owner.target, sessionId: owner.sessionId, file },
    near
  )

  useEffect(() => {
    const element = boxRef.current
    if (!element || near) {
      return
    }
    return observeTranscriptVisibility(element, (visible) => {
      if (visible) {
        setNear(true)
      }
    })
  }, [near])

  if (retired || state.status === 'unavailable') {
    return <NativeChatVisualUnavailable />
  }
  const label = title ?? file
  const openLabel = translate('components.native-chat.visualOpenInNewTab', 'Open in new tab')

  return (
    <div ref={boxRef} className="group/visual my-3">
      {state.status === 'ready' && near ? (
        <>
          {/* Above the frame, not over it: the page owns every pixel of its box. */}
          <div
            data-share-open={shareOpen}
            className="flex items-center justify-end gap-1 pb-1 transition-opacity can-hover:opacity-0 group-hover/visual:opacity-100 focus-within:opacity-100 data-[share-open=true]:opacity-100"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={openLabel}
                  onClick={() => openNativeChatVisualFile(owner.worktreeId, state.document.path)}
                >
                  <SquareArrowOutUpRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {openLabel}
              </TooltipContent>
            </Tooltip>
            <ArtifactPublishButton
              variant="outline"
              size="icon-xs"
              sourceKey={nativeChatVisualShareKey(owner, state.document.path)}
              createRequest={() => readNativeChatVisualShareRequest(owner, file)}
              open={shareOpen}
              onOpenChange={setShareOpen}
            />
          </div>
          <NativeChatVisualFrame
            document={state.document}
            title={label}
            themeScope={boxRef}
            onRetired={() => setRetired(true)}
            onReaderGesture={forwardGesture ?? undefined}
          />
        </>
      ) : (
        <div
          role="status"
          aria-label={translate('components.native-chat.visualLoading', 'Loading visualization')}
          className="w-full rounded-md bg-muted/30"
          style={{ height: NATIVE_CHAT_VISUAL_RESERVED_HEIGHT }}
        />
      )}
    </div>
  )
}
