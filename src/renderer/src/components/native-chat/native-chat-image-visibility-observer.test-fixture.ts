import { vi, type Mock } from 'vitest'

export class ImageVisibilityObserver implements IntersectionObserver {
  static current: ImageVisibilityObserver
  readonly root = null
  readonly rootMargin = '128px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  readonly observe: Mock = vi.fn()
  readonly unobserve: Mock = vi.fn()
  readonly disconnect: Mock = vi.fn()
  readonly takeRecords = (): IntersectionObserverEntry[] => []

  constructor(private readonly callback: IntersectionObserverCallback) {
    ImageVisibilityObserver.current = this
  }

  emit(target: Element, isIntersecting: boolean): void {
    const bounds = target.getBoundingClientRect()
    this.callback(
      [
        {
          target,
          isIntersecting,
          boundingClientRect: bounds,
          intersectionRect: bounds,
          rootBounds: null,
          intersectionRatio: isIntersecting ? 1 : 0,
          time: 0
        }
      ],
      this
    )
  }
}
