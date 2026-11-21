import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatMediaViewer } from '../NativeChatMediaViewer'
import {
  closeNativeChatVideoNotes,
  useNativeChatVideoNotesRequest
} from './native-chat-video-notes-request'
import { useNativeChatVideoSrc } from './use-native-chat-video-src'

/** The notes viewer for a video a link in this chat opened. */
export function NativeChatVideoNotesHost({
  root
}: {
  root: React.RefObject<HTMLElement | null>
}): React.JSX.Element | null {
  const t = useTranslate()
  const request = useNativeChatVideoNotesRequest(root)
  const opener = useMemo(() => ({ current: request?.opener ?? null }), [request])
  const { src, failed } = useNativeChatVideoSrc(request?.path ?? null)
  if (!request) {
    return null
  }
  return (
    <NativeChatMediaViewer
      open
      onOpenChange={(open) => {
        if (!open) {
          closeNativeChatVideoNotes(request)
        }
      }}
      kind="video"
      src={failed ? null : src}
      title={request.title}
      source={{ path: request.path }}
      opener={opener}
      onOpenInEditor={() => {
        closeNativeChatVideoNotes(request)
        request.openInEditor()
      }}
      fallback={
        <span className="text-sm text-media-canvas-foreground">
          {failed
            ? t('components.native-chat.notes.videoUnavailable', 'This video can’t be played here.')
            : t('components.native-chat.notes.videoLoading', 'Loading video…')}
        </span>
      }
    />
  )
}
