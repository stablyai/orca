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
      { width: 3000, height: 2000 }
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

test('exported pins align with a tall image after canvas dimensions are rounded', async ({
  page
}) => {
  await page.goto('/fixtures.html', { waitUntil: 'domcontentloaded' })
  const center = await page.evaluate(async () => {
    const pinsPath = '/src/components/native-chat/image-comment-pins.ts'
    const exportPath = '/src/components/editor/image-png-export.ts'
    const { paintImageCommentPins } = await import(pinsPath)
    const { renderImagePngDataUrl } = await import(exportPath)
    const source = `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="30000"><rect width="100%" height="100%" fill="white"/></svg>'
    )}`
    const png = await renderImagePngDataUrl(
      source,
      { width: 1080, height: 30000 },
      null,
      (context, layout) =>
        paintImageCommentPins(
          context,
          { width: 1080, height: 30000 },
          [{ id: 'tall-pin', x: 50, y: 90, comment: 'Keep this position' }],
          layout
        )
    )
    const image = new Image()
    image.src = png
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0)
    const column = context.getImageData(294, 14670, 1, 151).data
    const dark: number[] = []
    for (let i = 0; i < 151; i++) {
      if (
        column[i * 4] < 50 &&
        column[i * 4 + 1] < 50 &&
        column[i * 4 + 2] < 50 &&
        column[i * 4 + 3] === 255
      ) {
        dark.push(14670 + i)
      }
    }
    return dark.length ? (dark[0] + dark.at(-1)!) / 2 : null
  })
  expect(center).not.toBeNull()
  expect(center!).toBeGreaterThan(14743)
  expect(center!).toBeLessThan(14748)
})
