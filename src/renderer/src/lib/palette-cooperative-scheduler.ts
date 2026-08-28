import { yieldToEventLoop } from '../../../shared/event-loop-yield'

/** Yields past a paint before continuing bounded palette work. */
export async function yieldToPalettePaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') {
    await yieldToEventLoop()
    return
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      void yieldToEventLoop().then(resolve)
    })
  })
}
