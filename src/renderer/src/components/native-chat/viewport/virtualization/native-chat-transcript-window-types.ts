import type { VirtualItem } from '@tanstack/react-virtual'
import type { NativeChatAlignEdge } from './use-native-chat-viewport-align'

export type NativeChatTranscriptWindow = {
  virtualItems: VirtualItem[]
  totalSize: number
  scrollMargin: number
  sizerRef: (node: HTMLDivElement | null) => void
  measureRow: (node: HTMLElement | null) => void
  /** Scroll so this element's top meets the top of the viewport. */
  alignToViewportTop: (element: HTMLElement, edge?: NativeChatAlignEdge) => void
  /** Whether a jump is still settling as its target row is measured. */
  isAlignPending: () => boolean
  /** A reader gesture releases the jump's target. */
  cancelAlign: () => void
  releaseEndPin: () => void
  /** Pin through the virtualizer’s scroll owner to avoid competing writes; its last-row end includes trailing chrome. */
  scrollToEnd: () => void
  /** Restore a detached reader offset through the virtualizer's scroll owner. */
  restoreScrollOffset: (offset: number) => void
  /** True when this scroll event is the echo of a registered application write. */
  consumeProgrammaticScroll: (event: Event) => boolean
  /** Rebase a pending end reconcile while the reader takes over this frame. */
  reconcileReaderScroll: (isTakingOver: boolean) => void
}
