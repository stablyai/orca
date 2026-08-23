import { expect, test } from './helpers/orca-app'

type CloseFrame = {
  centerX: number
  centerY: number
  translate: string
}

test('Resource Manager keeps its dragged offset while closing and resets on reopen', async ({
  orcaPage: page
}) => {
  const trigger = page.getByRole('button', { name: /^Resource Manager/ })
  await expect(trigger).toBeVisible()
  await trigger.click()

  const panel = page.locator('[data-slot="popover-content"]')
  const header = page.getByRole('group', { name: 'Move Resource Manager' })
  await expect(header).toBeVisible()
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })

  const anchored = await panel.boundingBox()
  const anchoredTranslate = await panel.evaluate((element) => getComputedStyle(element).translate)
  const headerBox = await header.boundingBox()
  expect(anchored).not.toBeNull()
  expect(headerBox).not.toBeNull()
  if (!anchored || !headerBox) {
    throw new Error('Resource Manager geometry unavailable')
  }

  const dragStartX = headerBox.x + 80
  const dragStartY = headerBox.y + headerBox.height / 2
  await page.mouse.move(dragStartX, dragStartY)
  await page.mouse.down()
  await page.mouse.move(dragStartX - 160, dragStartY - 100, { steps: 8 })
  await page.mouse.up()

  const dragged = await panel.boundingBox()
  expect(dragged).not.toBeNull()
  if (!dragged) {
    throw new Error('Dragged Resource Manager geometry unavailable')
  }
  expect(anchored.x - dragged.x).toBeGreaterThan(120)
  expect(anchored.y - dragged.y).toBeGreaterThan(80)

  await header.focus()
  await header.press('ArrowRight')
  await header.press('Shift+ArrowUp')
  const keyboardMoved = await panel.boundingBox()
  expect(keyboardMoved).not.toBeNull()
  if (!keyboardMoved) {
    throw new Error('Keyboard-moved Resource Manager geometry unavailable')
  }
  expect(keyboardMoved.x).toBeCloseTo(dragged.x + 8, 0)
  expect(keyboardMoved.y).toBeCloseTo(dragged.y - 40, 0)

  const closeBaseline = {
    centerX: keyboardMoved.x + keyboardMoved.width / 2,
    centerY: keyboardMoved.y + keyboardMoved.height / 2,
    translate: await panel.evaluate((element) => getComputedStyle(element).translate)
  }
  await panel.evaluate((element) => {
    const frames: CloseFrame[] = []
    let exitActive = true
    Reflect.set(window, '__resourceManagerCloseFrames', frames)
    const stopSamplingExit = (event: Event): void => {
      if ((event as AnimationEvent).animationName === 'exit') {
        exitActive = false
      }
    }
    element.addEventListener('animationend', stopSamplingExit)
    element.addEventListener('animationcancel', stopSamplingExit)
    const sample = (): void => {
      if (!element.isConnected || !exitActive) {
        return
      }
      if (element.getAttribute('data-state') === 'closed') {
        const rect = element.getBoundingClientRect()
        frames.push({
          centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
          translate: getComputedStyle(element).translate
        })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  await page.getByRole('button', { name: 'Close Resource Manager' }).click()
  await expect(panel).toBeHidden()

  const closeFrames = await page.evaluate<CloseFrame[]>(() =>
    Reflect.get(window, '__resourceManagerCloseFrames')
  )
  expect(closeFrames.length).toBeGreaterThan(1)
  expect(closeFrames.every((frame) => frame.translate === closeBaseline.translate)).toBe(true)
  expect(
    Math.max(...closeFrames.map((frame) => Math.abs(frame.centerX - closeBaseline.centerX)))
  ).toBeLessThan(24)
  expect(
    Math.max(...closeFrames.map((frame) => Math.abs(frame.centerY - closeBaseline.centerY)))
  ).toBeLessThan(24)

  await trigger.click()
  await expect(panel).toBeVisible()
  const reopenedTranslate = await panel.evaluate((element) => getComputedStyle(element).translate)
  expect(reopenedTranslate).toBe(anchoredTranslate)
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  const reopened = await panel.boundingBox()
  expect(reopened).not.toBeNull()
  if (!reopened) {
    throw new Error('Reopened Resource Manager geometry unavailable')
  }
  expect(reopened.x).toBeCloseTo(anchored.x, 0)
  expect(reopened.y).toBeCloseTo(anchored.y, 0)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reopenedHeaderBox = await header.boundingBox()
  expect(reopenedHeaderBox).not.toBeNull()
  if (!reopenedHeaderBox) {
    throw new Error('Reopened Resource Manager header geometry unavailable')
  }
  const secondDragStartX = reopenedHeaderBox.x + 80
  const secondDragStartY = reopenedHeaderBox.y + reopenedHeaderBox.height / 2
  await page.mouse.move(secondDragStartX, secondDragStartY)
  await page.mouse.down()
  await page.mouse.move(secondDragStartX - 100, secondDragStartY - 60, { steps: 5 })
  await page.mouse.up()
  const secondDragged = await panel.boundingBox()
  expect(secondDragged).not.toBeNull()
  if (!secondDragged) {
    throw new Error('Reduced-motion drag geometry unavailable')
  }
  expect(anchored.x - secondDragged.x).toBeGreaterThan(60)
  expect(anchored.y - secondDragged.y).toBeGreaterThan(40)

  await page.getByRole('button', { name: 'Close Resource Manager' }).click()
  await trigger.click()
  await expect(panel).toBeVisible()
  const rapidTranslate = await panel.evaluate((element) => getComputedStyle(element).translate)
  expect(rapidTranslate).toBe(anchoredTranslate)
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished))
  })
  const rapidReopened = await panel.boundingBox()
  expect(rapidReopened).not.toBeNull()
  if (!rapidReopened) {
    throw new Error('Rapidly reopened Resource Manager geometry unavailable')
  }
  expect(rapidReopened.x).toBeCloseTo(anchored.x, 0)
  expect(rapidReopened.y).toBeCloseTo(anchored.y, 0)
})
