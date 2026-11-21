import { useEffect, useState } from 'react'
import type { NativeChatVideoSnapshot } from './native-chat-video-frames'

/** A captured frame shown in place of the video, for a note on a frame the video can't move to. */
export function NativeChatVideoStill({
  snapshot
}: {
  snapshot: NativeChatVideoSnapshot
}): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(snapshot.png)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [snapshot.png])
  return url ? (
    <img
      src={url}
      alt=""
      draggable={false}
      className="pointer-events-none absolute inset-0 size-full"
    />
  ) : null
}
