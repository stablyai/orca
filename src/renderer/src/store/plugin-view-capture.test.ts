import { afterEach, describe, expect, it } from 'vitest'
import { usePluginViewCaptureStore } from './plugin-view-capture'

afterEach(() => usePluginViewCaptureStore.getState().end())

describe('overlapping plugin shots', () => {
  it("leave a later shot's overrides alone when an earlier one ends", () => {
    const store = usePluginViewCaptureStore.getState()
    store.begin({ owner: 'a', panelWidth: 300, dark: true })
    store.begin({
      owner: 'b',
      panelWidth: null,
      dark: false,
      editorFileId: 'f',
      editorSize: { width: 400, height: 300 }
    })
    usePluginViewCaptureStore.getState().end('a')
    expect(usePluginViewCaptureStore.getState()).toMatchObject({
      dark: false,
      capturing: true,
      editorFileId: 'f',
      editorSize: { width: 400, height: 300 },
      owner: 'b'
    })
    usePluginViewCaptureStore.getState().end('b')
    expect(usePluginViewCaptureStore.getState()).toMatchObject({
      dark: null,
      capturing: false,
      editorFileId: null,
      owner: null
    })
  })

  it('ends whatever is on screen when no shot is named', () => {
    usePluginViewCaptureStore.getState().begin({ owner: 'a', panelWidth: 300, dark: true })
    usePluginViewCaptureStore.getState().end()
    expect(usePluginViewCaptureStore.getState()).toMatchObject({ capturing: false, dark: null })
  })
})
