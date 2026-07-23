import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import { PROJECT_HEADER_DROP_SETTLE_MS } from './project-header-drag-contract'

type ProjectHeaderDropSettleArgs = Parameters<typeof commitProjectHeaderDragDrop>[0] & {
  sourceTop: number | null
  dropPlaceholderY: number | null
  onSettle: (offsetY: number) => void
  onFinish: () => void
}

export function settleProjectHeaderDrop(args: ProjectHeaderDropSettleArgs): void {
  const canAnimate = args.sourceTop !== null && args.dropPlaceholderY !== null
  if (canAnimate) {
    args.onSettle(args.dropPlaceholderY! - args.sourceTop!)
  }
  const settleMs =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
      ? 0
      : PROJECT_HEADER_DROP_SETTLE_MS
  window.setTimeout(
    () => {
      const result = commitProjectHeaderDragDrop(args)
      if (result) {
        void result.then(args.onFinish, args.onFinish)
      } else {
        args.onFinish()
      }
    },
    canAnimate ? settleMs : 0
  )
}
