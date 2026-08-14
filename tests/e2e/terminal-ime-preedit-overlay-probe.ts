import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/**
 * Samples the xterm preedit overlay's real geometry.
 *
 * Why geometry and not the `active` class: an overlay forced to
 * `max-width: 0; overflow: hidden` is invisible on screen, yet keeps its class, its
 * `textContent`, `display: block` and `checkVisibility() === true`. The bounding rect is the
 * only property that discriminates, and it is also the only one a DOM emulator cannot produce —
 * happy-dom reports all-zero rects in every state, so a unit-level arm passes over an overlay
 * that never renders.
 */
export type PreeditOverlaySample = {
  found: boolean
  active: boolean
  text: string
  rect: { width: number; height: number }
  checkVisibility: boolean | null
  display: string
  visibility: string
  opacity: string
  maxWidth: string
  overflow: string
}

export function readPreeditOverlay(): PreeditOverlaySample {
  const textarea =
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus') ??
    document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
  const view = textarea?.parentElement?.querySelector<HTMLElement>('.composition-view') ?? null
  if (!view) {
    return {
      found: false,
      active: false,
      text: '',
      rect: { width: 0, height: 0 },
      checkVisibility: null,
      display: '',
      visibility: '',
      opacity: '',
      maxWidth: '',
      overflow: ''
    }
  }
  const style = getComputedStyle(view)
  const rect = view.getBoundingClientRect()
  return {
    found: true,
    active: view.classList.contains('active'),
    // The overlay wraps its text in LRM marks; strip them so assertions read as the user sees it.
    text: (view.textContent ?? '').replaceAll('‎', ''),
    rect: { width: rect.width, height: rect.height },
    checkVisibility: typeof view.checkVisibility === 'function' ? view.checkVisibility() : null,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    maxWidth: style.maxWidth,
    overflow: style.overflow
  }
}

export async function samplePreeditOverlay(page: Page): Promise<PreeditOverlaySample> {
  return page.evaluate(readPreeditOverlay)
}

export async function expectPreeditRendered(
  page: Page,
  expectedText: string,
  message: string
): Promise<PreeditOverlaySample> {
  await expect
    .poll(async () => (await samplePreeditOverlay(page)).text, { message })
    .toBe(expectedText)
  const sample = await samplePreeditOverlay(page)
  assertPreeditRendered(sample, expectedText, message)
  return sample
}

export function assertPreeditRendered(
  sample: PreeditOverlaySample,
  expectedText: string,
  message: string
): void {
  expect(sample.found, `${message}: no composition overlay exists`).toBe(true)
  expect(sample.text, `${message}: overlay text`).toBe(expectedText)
  expect(sample.active, `${message}: overlay is not marked active`).toBe(true)
  expect(sample.display, `${message}: overlay is display:none`).not.toBe('none')
  expect(sample.visibility, `${message}: overlay is not visible`).toBe('visible')
  expect(sample.checkVisibility, `${message}: overlay fails checkVisibility`).not.toBe(false)
  // The load-bearing pair. Do not weaken these to a class or visibility check.
  expect(sample.rect.width, `${message}: overlay has zero width`).toBeGreaterThan(0)
  expect(sample.rect.height, `${message}: overlay has zero height`).toBeGreaterThan(0)
  expect(sample.maxWidth, `${message}: overlay is clipped to zero width`).not.toBe('0px')
}

export async function expectPreeditHidden(page: Page, message: string): Promise<void> {
  await expect.poll(async () => (await samplePreeditOverlay(page)).active, { message }).toBe(false)
  const sample = await samplePreeditOverlay(page)
  expect(sample.rect.width, `${message}: overlay still occupies width`).toBe(0)
  expect(sample.rect.height, `${message}: overlay still occupies height`).toBe(0)
}
