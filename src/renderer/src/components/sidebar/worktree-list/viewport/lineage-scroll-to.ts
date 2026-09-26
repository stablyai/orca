import { elementScroll, type VirtualizerOptions } from '@tanstack/react-virtual'

export const scrollLineageVirtualizer: VirtualizerOptions<
  HTMLDivElement,
  HTMLDivElement
>['scrollToFn'] = (offset, options, instance) => {
  // An implicit same-offset write would cancel the outer owner's smooth reveal.
  if (
    options.behavior === undefined &&
    instance.scrollElement?.scrollTop === offset + (options.adjustments ?? 0)
  ) {
    return
  }
  elementScroll(offset, options, instance)
}
