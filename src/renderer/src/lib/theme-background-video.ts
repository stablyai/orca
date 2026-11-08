import type { PluginThemeBackground } from '../../../shared/plugins/artifacts/plugin-theme-background'
import { PLUGIN_THEME_VIDEO_RULE } from '../../../shared/plugins/media/plugin-theme-video-rules'

const LAYER_CLASS = 'theme-background-video'
const OVERLAY_ATTRIBUTES = ['data-modal-overlay-open', 'data-onboarding-overlay-open']

type VideoLayer = { layer: HTMLDivElement; video: HTMLVideoElement; observer: MutationObserver }

let current: VideoLayer | null = null
let wantsPlay = false
// Why remember: an unplayable video must not be refetched on every focus change.
let failedUrl: string | null = null

/** Why paused under overlays: their backdrop blur would re-filter the window on every frame. */
function syncPlayback(): void {
  if (!current) {
    return
  }
  const overlayOpen = OVERLAY_ATTRIBUTES.some((name) => document.body.hasAttribute(name))
  if (wantsPlay && !overlayOpen) {
    // A rejected play (autoplay policy, decode failure) leaves the paused frame or the still.
    void current.video.play().catch(() => undefined)
  } else {
    current.video.pause()
  }
}

function removeLayer(): void {
  current?.observer.disconnect()
  current?.video.removeAttribute('src')
  // Why load(): releases the decoder and its buffers instead of waiting for collection.
  current?.video.load()
  current?.layer.remove()
  current = null
}

function createLayer(url: string): VideoLayer {
  const layer = document.createElement('div')
  layer.className = LAYER_CLASS
  layer.setAttribute('aria-hidden', 'true')
  const video = document.createElement('video')
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.disablePictureInPicture = true
  video.disableRemotePlayback = true
  video.preload = 'auto'
  // Why reveal on first frame: until then, and if the codec cannot play, the static image shows.
  video.addEventListener('loadeddata', () => layer.setAttribute('data-ready', ''), { once: true })
  const fail = (): void => {
    if (current?.video === video) {
      failedUrl = url
      removeLayer()
    }
  }
  video.addEventListener('error', fail)
  // Why re-check: main checked the file's header claims; this is what the decoder finds, and a
  // stream may change size or length after it starts.
  const recheck = (): void => {
    const pixels = video.videoWidth * video.videoHeight
    if (
      pixels > PLUGIN_THEME_VIDEO_RULE.maxPixels ||
      video.duration * 1000 > PLUGIN_THEME_VIDEO_RULE.maxDurationMs
    ) {
      fail()
    }
  }
  video.addEventListener('loadedmetadata', recheck)
  video.addEventListener('resize', recheck)
  video.addEventListener('durationchange', recheck)
  video.src = url
  layer.append(video)
  document.body.prepend(layer)
  const observer = new MutationObserver(syncPlayback)
  observer.observe(document.body, { attributes: true, attributeFilter: OVERLAY_ATTRIBUTES })
  return { layer, video, observer }
}

/** Shows (or removes) the theme's muted, looping video over its static image; see main.css.
 *  `playing` false pauses on the current frame, which costs no decode or compositing. */
export function syncThemeBackgroundVideo(
  background: PluginThemeBackground | null,
  playing: boolean
): void {
  const url = background?.videoUrl
  if (!url || url === failedUrl) {
    removeLayer()
    return
  }
  if (current?.video.getAttribute('src') !== url) {
    removeLayer()
    current = createLayer(url)
  }
  wantsPlay = playing
  syncPlayback()
}
