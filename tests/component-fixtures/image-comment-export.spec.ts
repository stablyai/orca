import { expect, test } from '@playwright/test'

test('exported numbered markers remain legible after a large image is downscaled', async ({
  page
}) => {
  await page.goto('/fixtures.html', { waitUntil: 'domcontentloaded' })
  const pixel = await page.evaluate(async () => {
    const path = '/src/components/native-chat/image-comment-pins.ts'
    const { paintImageCommentPins } = await import(path)
    const large = document.createElement('canvas')
    large.width = 3000
    large.height = 2000
    const context = large.getContext('2d')!
    context.fillStyle = 'white'
    context.fillRect(0, 0, 3000, 2000)
    paintImageCommentPins(
      context,
      { width: 3000, height: 2000 },
      [{ id: 'pin', x: 50, y: 50, comment: 'Feedback' }],
      1
    )
    const small = document.createElement('canvas')
    small.width = 600
    small.height = 400
    const thumbnail = small.getContext('2d')!
    thumbnail.drawImage(large, 0, 0, 600, 400)
    return [...thumbnail.getImageData(306, 186, 1, 1).data]
  })
  expect(pixel[0]).toBeLessThan(50)
  expect(pixel[1]).toBeLessThan(50)
  expect(pixel[2]).toBeLessThan(50)
  expect(pixel[3]).toBe(255)
})
