/** Root class that drops the app's opaque fill so the platform blur material behind the web contents shows (#8797). */
export const WINDOW_BLUR_ROOT_CLASS = 'window-blur'

export function applyWindowBlurRootClass(root: HTMLElement, enabled: boolean): void {
  root.classList.toggle(WINDOW_BLUR_ROOT_CLASS, enabled)
}
