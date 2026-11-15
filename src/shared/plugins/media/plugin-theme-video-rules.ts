import type { PluginVideoCodec, PluginVideoInfo } from './plugin-video-format'

/** Limits for an app theme's background video. Why video, not animated images: an animated WebP
 *  is decoded in software every frame and cost two to four times the CPU of the same loop as
 *  video. Why these codecs: Chromium can decode them everywhere, in software if need be; HEVC has
 *  no software decoder, so it fails on machines without one in hardware. */
export const PLUGIN_THEME_VIDEO_RULE = {
  codecs: ['h264', 'vp9', 'av1'] satisfies readonly PluginVideoCodec[],
  // Why: a 30-second 960×540 loop is 1.5 to 2.6 MB; the cap leaves room for longer or sharper loops.
  maxBytes: 8 * 1024 * 1024,
  maxDurationMs: 60_000,
  minWidth: 640,
  minHeight: 360,
  // Why: bounds each frame's decode and upload; it is stretched to cover the window anyway.
  maxPixels: 1920 * 1200
} as const

const CODEC_NAMES: Record<PluginVideoCodec, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1'
}

const ALLOWED_CODECS: readonly PluginVideoCodec[] = PLUGIN_THEME_VIDEO_RULE.codecs

/** Null when a video fits the theme background rules, else why not. */
export function pluginThemeVideoRuleError(info: PluginVideoInfo, bytes: number): string | null {
  const rule = PLUGIN_THEME_VIDEO_RULE
  if (!ALLOWED_CODECS.includes(info.codec)) {
    return `video codec must be H.264 (recommended), VP9 or AV1, not ${CODEC_NAMES[info.codec]}`
  }
  if (bytes > rule.maxBytes) {
    return `video must be at most ${rule.maxBytes / 1024 / 1024} MB`
  }
  if (info.durationMs > rule.maxDurationMs) {
    return `video must be at most ${rule.maxDurationMs / 1000} seconds`
  }
  if (info.width < rule.minWidth || info.height < rule.minHeight) {
    return `video must be at least ${rule.minWidth}×${rule.minHeight}`
  }
  if (info.width * info.height > rule.maxPixels) {
    return `video must be at most ${rule.maxPixels.toLocaleString('en-US')} pixels`
  }
  return null
}

export const PLUGIN_THEME_VIDEO_RULE_TEXT = `H.264 MP4 (recommended: decoded in hardware everywhere) or VP9 or AV1 WebM; at least ${PLUGIN_THEME_VIDEO_RULE.minWidth}×${PLUGIN_THEME_VIDEO_RULE.minHeight}, at most ${PLUGIN_THEME_VIDEO_RULE.maxPixels.toLocaleString('en-US')} pixels, ${PLUGIN_THEME_VIDEO_RULE.maxDurationMs / 1000} seconds and ${PLUGIN_THEME_VIDEO_RULE.maxBytes / 1024 / 1024} MB. No audio track.`
