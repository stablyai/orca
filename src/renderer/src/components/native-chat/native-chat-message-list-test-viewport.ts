const TEST_VIEWPORT_HEIGHT_PX = 1_000_000
const TEST_ROW_HEIGHT_PX = 48

/** Give non-windowing component tests a measurable viewport that contains every fixture row. */
export function installNativeChatMessageListTestViewport(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.hasAttribute('data-native-chat-scroll')) {
        return TEST_VIEWPORT_HEIGHT_PX
      }
      if (this.dataset.index !== undefined) {
        return TEST_ROW_HEIGHT_PX
      }
      return original?.get?.call(this) ?? 0
    }
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
    }
  }
}
