// @vitest-environment happy-dom
import { Blob as NodeBlob, resolveObjectURL } from 'node:buffer'
import { URL as NodeURL } from 'node:url'
import { Activity, StrictMode, useState } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeChatPaneLifetime } from '../pane/ownership/native-chat-pane-lifetime'
import { useNativeChatPasteLifetime } from './use-native-chat-paste-lifetime'

function Composer() {
  const [preview, setPreview] = useState<string>()
  const paste = useNativeChatPasteLifetime({
    targetKey: 'chat',
    beginPendingImageAttachment: (url) => {
      setPreview(url)
      return 'pending-image'
    },
    resolvePendingImageAttachment: () => {},
    dropPendingImageAttachment: () => setPreview(undefined)
  })
  return (
    <>
      <button
        onClick={() =>
          paste.startImageChip({ kind: 'local' }, new Blob(['pending image']), {
            deferPreview: false,
            canShow: () => true
          })
        }
      >
        Paste image
      </button>
      {preview && <img alt="Pending attachment" src={preview} />}
    </>
  )
}

it('keeps a pending image readable across chat switches and releases it when the chat closes', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    if (!(blob instanceof NodeBlob)) {
      throw new Error('Expected a native blob')
    }
    return NodeURL.createObjectURL(blob)
  })
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(NodeURL.revokeObjectURL)
  const pane = (visible: boolean) => (
    <StrictMode>
      <NativeChatPaneLifetime isVisible={visible}>
        <Activity mode={visible ? 'visible' : 'hidden'}>
          <Composer />
        </Activity>
      </NativeChatPaneLifetime>
    </StrictMode>
  )
  const view = render(pane(true))
  try {
    fireEvent.click(view.getByRole('button', { name: 'Paste image' }))
    const source = view.getByAltText('Pending attachment').getAttribute('src')!
    expect(await resolveObjectURL(source)?.text()).toBe('pending image')
    view.rerender(pane(false))
    await act(async () => {})
    expect(await resolveObjectURL(source)?.text()).toBe('pending image')
    view.rerender(pane(true))
    expect(view.getByAltText('Pending attachment').getAttribute('src')).toBe(source)
    expect(await resolveObjectURL(source)?.text()).toBe('pending image')
    view.rerender(pane(false))
    view.unmount()
    await act(async () => {})
    expect(resolveObjectURL(source)).toBeUndefined()
  } finally {
    view.unmount()
    createUrl.mockRestore()
    revokeUrl.mockRestore()
    vi.unstubAllGlobals()
  }
})
