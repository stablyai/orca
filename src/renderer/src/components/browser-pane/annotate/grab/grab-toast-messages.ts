import { translate } from '@/i18n/i18n'

/** Toast copy for the grab picker's results. */
export const copiedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.0c7b9b2b7a',
    'Copied'
  )
export const screenshottedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.c937229f19',
    'Screenshotted'
  )
export const annotationAddedGrabToastMessage = (): string =>
  translate(
    'auto.components.browser.pane.annotate.use.browser.page.grab.annotations.1f5cb19034',
    'Annotation added'
  )
export const noScreenshotGrabToastMessage = (): string =>
  translate('browser.grabToast.noScreenshot', 'No screenshot available')
export const hoverReadFailedGrabToastMessage = (): string =>
  translate('browser.grabToast.hoverReadFailed', 'Could not read the hovered element')
export const noHoverGrabToastMessage = (): string =>
  translate('browser.grabToast.noHover', 'No element hovered')
export const copyFailedGrabToastMessage = (): string =>
  translate('browser.grabToast.copyFailed', "Couldn't copy")
