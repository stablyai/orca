// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_PASTE_EVENT } from '../../lib/app-menu-paste'
import {
  listenForRoomComposerAppMenuPaste,
  readRoomComposerClipboardImage
} from './room-composer-clipboard-paste'

const originalApi = window.api

afterEach(() => {
  window.api = originalApi
  document.body.replaceChildren()
})

describe('room composer clipboard paste', () => {
  it('claims app-menu paste only while the room composer owns focus', () => {
    const root = document.createElement('div')
    const input = document.createElement('textarea')
    const outside = document.createElement('button')
    root.append(input)
    document.body.append(root, outside)
    const onPaste = vi.fn()
    const stop = listenForRoomComposerAppMenuPaste(root, onPaste)

    input.focus()
    const owned = new CustomEvent(APP_MENU_PASTE_EVENT, { cancelable: true })
    window.dispatchEvent(owned)
    expect(owned.defaultPrevented).toBe(true)
    expect(onPaste).toHaveBeenCalledOnce()

    outside.focus()
    const unowned = new CustomEvent(APP_MENU_PASTE_EVENT, { cancelable: true })
    window.dispatchEvent(unowned)
    expect(unowned.defaultPrevented).toBe(false)
    stop()
  })

  it('loads the Electron clipboard PNG as a browser File', async () => {
    window.api = {
      ui: {
        readClipboardImage: vi.fn().mockResolvedValue({
          content: new Uint8Array([112, 110, 103]).buffer,
          mimeType: 'image/png'
        })
      }
    } as never

    const file = await readRoomComposerClipboardImage()

    expect(file).toMatchObject({ name: 'pasted-image.png', size: 3, type: 'image/png' })
  })
})
