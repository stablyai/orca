import { elementScroll, type VirtualizerOptions } from '@tanstack/react-virtual'

export const scrollSidebarVirtualizer: VirtualizerOptions<
  HTMLDivElement,
  HTMLDivElement
>['scrollToFn'] = (offset, options, instance) => {
  // Attaching at the current offset must not cancel an existing smooth reveal.
  if (
    options.behavior === undefined &&
    instance.scrollElement?.scrollTop === offset + (options.adjustments ?? 0)
  ) {
    return
  }
  elementScroll(offset, options, instance)
}
