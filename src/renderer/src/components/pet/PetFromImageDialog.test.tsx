// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { blankImage } from './pet-raster-transform'
import type { RgbaImage } from './pet-image-cutout'

/** A character on transparent background, big enough to pass the quality gate. */
function characterImage(): RgbaImage {
  const img = blankImage(60, 90)
  const paint = (x: number, y: number): void => {
    const i = (y * 60 + x) * 4
    img.data[i] = 120
    img.data[i + 1] = 60
    img.data[i + 2] = 200
    img.data[i + 3] = 255
  }
  for (let y = 10; y < 34; y++) {
    for (let x = 24; x < 36; x++) {
      paint(x, y)
    }
  }
  for (let y = 34; y < 78; y++) {
    for (let x = 16; x < 44; x++) {
      paint(x, y)
    }
  }
  return img
}

/** Opaque noise: the fill cannot separate it, so the gate must refuse it. */
function noisyImage(): RgbaImage {
  const img = blankImage(60, 90)
  for (let p = 0; p < 60 * 90; p++) {
    img.data[p * 4] = (p * 53) % 240
    img.data[p * 4 + 1] = 80
    img.data[p * 4 + 2] = 120
    img.data[p * 4 + 3] = 255
  }
  return img
}

const decoded = vi.hoisted(() => ({ current: null as RgbaImage | null }))
const createGenerated = vi.hoisted(() => vi.fn())

vi.mock('./pet-image-decode', () => ({
  decodeImageFile: async () => decoded.current,
  encodeSheetToWebp: async () => new ArrayBuffer(8),
  imageToDataUrl: async () => 'data:image/webp;base64,PREVIEW'
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { PetFromImageDialog } from './PetFromImageDialog'

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(props: Partial<React.ComponentProps<typeof PetFromImageDialog>> = {}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <PetFromImageDialog open onOpenChange={() => {}} onCreated={() => {}} {...props} />
    )
  })
}

async function pickFile(): Promise<void> {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  Object.defineProperty(input, 'files', {
    value: [new File([new Uint8Array([1])], 'pet.png', { type: 'image/png' })],
    configurable: true
  })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** Drags a marquee across the crop surface, in surface-local coordinates. */
async function dragCrop(
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  const surface = document.querySelector('[data-crop-surface]') as HTMLElement
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 120, height: 120, right: 120, bottom: 120, x: 0, y: 0 }) as DOMRect
  const at = (type: string, p: { x: number; y: number }): PointerEvent =>
    new PointerEvent(type, { clientX: p.x, clientY: p.y, bubbles: true, pointerId: 1 })
  await act(async () => {
    surface.dispatchEvent(at('pointerdown', from))
  })
  await act(async () => {
    surface.dispatchEvent(at('pointermove', to))
    surface.dispatchEvent(at('pointerup', to))
  })
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

beforeEach(() => {
  decoded.current = characterImage()
  createGenerated.mockReset().mockResolvedValue({ id: 'new-pet', label: 'pet' })
  ;(window as unknown as { api: unknown }).api = { pet: { createGenerated } }
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  root = null
  container = null
})

describe('PetFromImageDialog', () => {
  it('previews the pet once an image is chosen', async () => {
    render()

    await pickFile()

    expect(document.querySelector('[data-preview-row]')).not.toBeNull()
  })

  it('refuses a background it cannot separate, and says what to do', async () => {
    decoded.current = noisyImage()
    render()

    await pickFile()

    expect(bodyText()).toContain('background')
    expect(bodyText().toLowerCase()).toMatch(/transparent|plain background/)
    expect(document.querySelector('[data-preview-row]')).toBeNull()
  })

  it('does not save anything until the user confirms', async () => {
    render()

    await pickFile()

    expect(createGenerated).not.toHaveBeenCalled()
  })

  it('saves the generated sheet on confirm', async () => {
    const onCreated = vi.fn()
    render({ onCreated })

    await pickFile()
    const save = [...document.querySelectorAll('button')].find((b) =>
      /create pet/i.test(b.textContent ?? '')
    ) as HTMLButtonElement
    await act(async () => {
      save.click()
    })

    expect(createGenerated).toHaveBeenCalledTimes(1)
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-pet' }))
  })

  it('offers a rejected image no way to be saved', async () => {
    decoded.current = noisyImage()
    render()

    await pickFile()

    const save = [...document.querySelectorAll('button')].find((b) =>
      /create pet/i.test(b.textContent ?? '')
    ) as HTMLButtonElement | undefined
    expect(save === undefined || save.disabled).toBe(true)
  })

  it('offers the three ways of building a pet', async () => {
    render()
    await pickFile()

    const text = bodyText().toLowerCase()
    expect(text).toContain('whole body')
    expect(text).toContain('walking legs')
    expect(text).toContain('head only')
  })

  it('says so when the walking rig could not be found, rather than pretending', async () => {
    // A pillar has no legs to rig; the build degrades and must admit it.
    const pillar = blankImage(60, 90)
    for (let y = 8; y < 84; y++) {
      for (let x = 20; x < 40; x++) {
        const i = (y * 60 + x) * 4
        pillar.data[i] = 90
        pillar.data[i + 1] = 90
        pillar.data[i + 2] = 160
        pillar.data[i + 3] = 255
      }
    }
    decoded.current = pillar
    render()
    await pickFile()

    const rigged = [...document.querySelectorAll('button')].find((b) =>
      /walking legs/i.test(b.textContent ?? '')
    ) as HTMLButtonElement
    await act(async () => {
      rigged.click()
    })

    expect(bodyText().toLowerCase()).toMatch(/no legs|could not|whole body instead/)
  })

  it('starts with the whole picture in frame', async () => {
    render()

    await pickFile()

    expect(document.querySelector('[data-crop]')?.getAttribute('data-crop')).toBe('none')
  })

  it('offers the framing controls even when the upload is refused', async () => {
    decoded.current = noisyImage()
    render()

    await pickFile()

    expect(document.querySelector('[data-crop-surface]')).not.toBeNull()
    expect(document.querySelector('[data-tolerance]')).not.toBeNull()
  })

  it('rebuilds from the region the user frames', async () => {
    render()

    await pickFile()
    await dragCrop({ x: 10, y: 10 }, { x: 40, y: 60 })

    expect(document.querySelector('[data-crop]')?.getAttribute('data-crop')).not.toBe('none')
  })

  it('puts the whole picture back when framing is cleared', async () => {
    render()

    await pickFile()
    await dragCrop({ x: 10, y: 10 }, { x: 40, y: 60 })
    const reset = [...document.querySelectorAll('button')].find((b) =>
      /whole picture/i.test(b.textContent ?? '')
    ) as HTMLButtonElement
    await act(async () => {
      reset.click()
    })

    expect(document.querySelector('[data-crop]')?.getAttribute('data-crop')).toBe('none')
  })

  it('rebuilds when the background tolerance is widened', async () => {
    render()

    await pickFile()
    const before = document.querySelector('[data-tolerance]')?.getAttribute('data-tolerance')
    const thumb = document.querySelector('[data-slot="slider-thumb"]') as HTMLElement
    await act(async () => {
      thumb.focus()
      thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })

    expect(document.querySelector('[data-tolerance]')?.getAttribute('data-tolerance')).not.toBe(
      before
    )
  })
})
