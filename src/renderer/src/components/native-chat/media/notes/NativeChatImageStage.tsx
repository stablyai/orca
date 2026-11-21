import type { PanZoomSize } from '../../../../../../shared/document-preview/pan-zoom-view'
import { NativeChatMediaImageLoader } from './NativeChatMediaViewerChrome'
import type { NativeChatMediaLoaded } from './native-chat-notes-handoff'

/** An image in the notes viewer: drawn at the viewport's zoom, with the marks over it. */
export function NativeChatImageStage({
  src,
  title,
  loaded,
  onLoaded,
  broken,
  onBroken,
  fallback,
  scale,
  offset,
  marks
}: {
  src: string | null
  title: string
  loaded: NativeChatMediaLoaded | null
  onLoaded: (loaded: NativeChatMediaLoaded) => void
  broken: boolean
  onBroken: () => void
  fallback?: React.ReactNode
  scale: number
  offset: { x: number; y: number } | null
  marks: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      {src && offset && loaded ? (
        <div
          className="absolute top-0 left-0"
          style={{
            width: loaded.size.width * scale,
            height: loaded.size.height * scale,
            transform: `translate(${offset.x}px, ${offset.y}px)`
          }}
        >
          <img
            src={src}
            alt={title}
            draggable={false}
            className="pointer-events-none size-full select-none rounded-sm"
          />
          <div className="absolute inset-0">{marks}</div>
        </div>
      ) : null}
      {src && !loaded && !broken ? (
        <NativeChatMediaImageLoader
          src={src}
          onLoaded={({ image, size }) => onLoaded(nativeChatLoadedImage(image, size))}
          onError={onBroken}
        />
      ) : null}
      {!src || broken ? (
        <div className="flex size-full items-center justify-center">{fallback}</div>
      ) : null}
    </>
  )
}

/** A loaded image: every note is on the image itself. */
export function nativeChatLoadedImage(
  image: HTMLImageElement,
  size: PanZoomSize
): NativeChatMediaLoaded {
  return { kind: 'image', size, frame: async () => ({ image, ...size }) }
}
