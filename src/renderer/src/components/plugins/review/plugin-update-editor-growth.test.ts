import { describe, expect, it } from 'vitest'
import { editorGrowth } from './plugin-update-editor-growth'

type Editor = {
  id: string
  extensions?: string[]
  filenames?: string[]
  priority?: string
  contentKind?: string
}
const editors = (...list: Editor[]) => ({ contributes: { customEditors: list } })

describe('editorGrowth', () => {
  it('names the file types no installed editor opened', () => {
    expect(
      editorGrowth(
        editors({ id: 'a', extensions: ['.excalidraw', '.excalidraw.json'] }),
        editors(
          { id: 'a', extensions: ['.excalidraw', '.excalidraw.json'] },
          { id: 'svg', extensions: ['.excalidraw.svg'] },
          { id: 'png', extensions: ['.Excalidraw.png'], filenames: ['board.draw'] }
        )
      )
    ).toEqual({
      files: ['.excalidraw.svg', '.Excalidraw.png', 'board.draw'],
      defaults: [],
      other: false
    })
  })

  it('names the files an editor now opens by default', () => {
    expect(
      editorGrowth(
        editors({ id: 'md', extensions: ['.md'], priority: 'option' }),
        editors({ id: 'md', extensions: ['.md'] })
      )
    ).toEqual({ files: [], defaults: ['.md'], other: false })
  })

  it('flags growth it cannot name: a new id over held files, or a changed content kind', () => {
    expect(
      editorGrowth(
        editors({ id: 'a', extensions: ['.md'] }),
        editors({ id: 'b', extensions: ['.md'] })
      ).other
    ).toBe(true)
    expect(
      editorGrowth(
        editors({ id: 'a', extensions: ['.png'] }),
        editors({ id: 'a', extensions: ['.png'], contentKind: 'bytes' })
      ).other
    ).toBe(true)
  })
})
