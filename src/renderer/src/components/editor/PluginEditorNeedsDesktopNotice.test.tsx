// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useCustomEditorViewStore,
  type ActivePluginCustomEditor
} from '@/store/plugins/file-editors/plugin-custom-editors'
import { usePluginFrameIsolationStore } from '@/store/plugins/frames/plugin-frame-isolation'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

import PluginCustomEditorFrame from './PluginCustomEditorFrame'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const FILE_ID = '/repo/diagram.excalidraw'
const editor: ActivePluginCustomEditor = {
  id: 'excalidraw',
  title: 'Excalidraw',
  extensions: ['.excalidraw'],
  filenames: [],
  priority: 'default',
  frame: 'isolated',
  key: 'stablyai.excalidraw/excalidraw',
  pluginKey: 'stablyai.excalidraw',
  pluginName: 'Excalidraw'
}

let container: HTMLDivElement
let root: Root
const readCustomEditorEntry = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  usePluginFrameIsolationStore.setState({ isolated: null })
  useCustomEditorViewStore.setState({ choices: {} })
  // Isolated frames switched off: main hands back the srcdoc document, with no guest.
  readCustomEditorEntry.mockResolvedValue({ html: '<!doctype html>', sessionToken: 't'.repeat(43) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame reads only these two plugin bridge methods.
  globalThis.window.api = {
    plugins: { readCustomEditorEntry, onChanged: () => vi.fn() }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderFrame(frameEditor: ActivePluginCustomEditor): Promise<void> {
  await act(async () => {
    root.render(
      <PluginCustomEditorFrame
        editor={frameEditor}
        fileId={FILE_ID}
        content="{}"
        readOnly={false}
        onContentChange={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
      />
    )
  })
}

describe('an isolated-only editor without an isolated frame', () => {
  it('shows that it needs the desktop app instead of the srcdoc frame, and opens Source', async () => {
    await renderFrame(editor)
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('This editor needs the Orca desktop app')
    expect(container.textContent).toContain('isolated plugin frames are turned off')
    expect(usePluginFrameIsolationStore.getState().isolated).toBe(false)
    const open = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open Source'
    )
    await act(async () => open?.click())
    expect(useCustomEditorViewStore.getState().choices[FILE_ID]).toBe('source')
  })
})
