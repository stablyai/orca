import { describe, expect, it } from 'vitest'
import { addedEditorFiles } from './PluginUpdateCandidate'

const withEditors = (...editors: { extensions?: string[]; filenames?: string[] }[]) => ({
  contributes: { customEditors: editors }
})

describe('addedEditorFiles', () => {
  it('names only the file types the installed editors did not open', () => {
    expect(
      addedEditorFiles(
        withEditors({ extensions: ['.excalidraw', '.excalidraw.json'] }),
        withEditors(
          { extensions: ['.excalidraw', '.excalidraw.json'] },
          { extensions: ['.excalidraw.svg'] },
          { extensions: ['.Excalidraw.json', '.excalidraw.png'], filenames: ['board.draw'] }
        )
      )
    ).toEqual(['.excalidraw.svg', '.excalidraw.png', 'board.draw'])
  })

  it('names none when the editors only changed how they open the same files', () => {
    expect(
      addedEditorFiles(withEditors({ extensions: ['.md'] }), withEditors({ extensions: ['.md'] }))
    ).toEqual([])
  })
})
