// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeChatComposerFrame } from './NativeChatComposerFrame'

async function renderFrame(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <NativeChatComposerFrame commandMenu={null} notice={null} pendingPrompt={null}>
        <textarea />
      </NativeChatComposerFrame>
    )
  })
  return { container, root }
}

function dispatchDrag(target: Element, type: string, types: string[]): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: { types }
  })
  target.dispatchEvent(event)
}

function dispatchNativeFileDrag(target: Element, type: string): void {
  dispatchDrag(target, type, ['Files'])
}

describe('NativeChatComposerFrame', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('marks the composer frame while a native file drag is over it', async () => {
    const { container, root } = await renderFrame()
    const frame = container.querySelector('[data-native-file-drop-target="composer"]')
    if (!frame) {
      throw new Error('Missing composer drop target')
    }

    await act(async () => {
      dispatchNativeFileDrag(frame, 'dragenter')
    })
    expect(frame.getAttribute('data-native-file-drop-active')).toBe('true')

    await act(async () => {
      document.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    expect(frame.getAttribute('data-native-file-drop-active')).toBeNull()
    act(() => root.unmount())
  })

  it('ignores non-file drags', async () => {
    const { container, root } = await renderFrame()
    const frame = container.querySelector('[data-native-file-drop-target="composer"]')
    if (!frame) {
      throw new Error('Missing composer drop target')
    }

    await act(async () => {
      dispatchDrag(frame, 'dragenter', ['text/plain'])
    })

    expect(frame.getAttribute('data-native-file-drop-active')).toBeNull()
    act(() => root.unmount())
  })
})
