import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getTerminalDropUploadProgress } from './terminal-drop-upload-progress'

const mocks = vi.hoisted(() => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: mocks.translate
}))

describe('getTerminalDropUploadProgress', () => {
  beforeEach(() => {
    mocks.translate.mockClear()
  })

  it('uses complete singular and plural runtime messages', () => {
    getTerminalDropUploadProgress(1, 'runtime')
    getTerminalDropUploadProgress(2, 'runtime')

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRuntime',
      'Uploading {{count}} file to runtime…',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRuntime',
      'Uploading {{count}} files to runtime…',
      { count: 2 }
    )
  })

  it('uses complete singular and plural remote messages', () => {
    getTerminalDropUploadProgress(1, 'remote')
    getTerminalDropUploadProgress(2, 'remote')

    expect(mocks.translate).toHaveBeenNthCalledWith(
      1,
      'auto.components.terminal.pane.terminal.drop.handler.uploadingOneFileToRemote',
      'Uploading {{count}} file to remote…',
      { count: 1 }
    )
    expect(mocks.translate).toHaveBeenNthCalledWith(
      2,
      'auto.components.terminal.pane.terminal.drop.handler.uploadingManyFilesToRemote',
      'Uploading {{count}} files to remote…',
      { count: 2 }
    )
  })
})
