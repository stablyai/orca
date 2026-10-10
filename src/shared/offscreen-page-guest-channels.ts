/** A guest frame asks main whether its page is offscreen; main answers with the channels below. */
export const OFFSCREEN_PAGE_GUEST_KIND_CHANNEL = 'offscreen-page:is-offscreen'

/** Channels an offscreen page's frames use on the page's own ipc. */
export const OFFSCREEN_PAGE_GUEST_CHANNELS = {
  /** Frames report their hover tooltip. */
  tooltip: 'offscreen-page:tooltip',
  /** Main asks for the open datalist's rows; the focused frame answers on datalistItems. */
  datalistQuery: 'offscreen-page:datalist-query',
  datalistItems: 'offscreen-page:datalist-items'
} as const

export type OffscreenPageGuestChannels = {
  [K in keyof typeof OFFSCREEN_PAGE_GUEST_CHANNELS]: string
}

export type OffscreenPageDatalistItem = { value: string; label: string }
