import { describe, expect, it } from 'vitest'
import { MAX_CUSTOM_PET_DETECTED_FRAMES } from '../../../../shared/custom-pet-media-limits'
import { detectFramesFromImageData } from './sprite-frame-detection'

function stripedImage(frameCount: number): ImageData {
  const frameWidth = 8
  const width = frameCount * (frameWidth + 1)
  const height = 8
  const data = new Uint8ClampedArray(width * height * 4)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const startX = frame * (frameWidth + 1)
    for (let y = 0; y < height; y += 1) {
      for (let x = startX; x < startX + frameWidth; x += 1) {
        data[(y * width + x) * 4 + 3] = 255
      }
    }
  }
  return { data, width, height } as ImageData
}

describe('detectFramesFromImageData', () => {
  it('keeps ordinary auto-detected sprite animations unchanged', () => {
    expect(detectFramesFromImageData(stripedImage(3))?.frames).toHaveLength(3)
  })

  it('falls back to a static sheet above the bitmap fan-out cap', () => {
    expect(detectFramesFromImageData(stripedImage(MAX_CUSTOM_PET_DETECTED_FRAMES + 1))).toBeNull()
  })
})
