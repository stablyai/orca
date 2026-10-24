import { describe, expect, it } from 'vitest'
import {
  convertedCsvColumnWidthsKey,
  convertedFileViewPreferenceKey,
  convertedNotebookEnvironment,
  convertedQuickOpenHistoryScope,
  wslDriveUncRendererKeys
} from './wsl-drive-unc-renderer-store-keys'

const UNC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`
const OLD_ID = `r1::${UNC}`
const NEW_ID = String.raw`r1::C:\src\app`
const keys = wslDriveUncRendererKeys({
  distro: 'Ubuntu',
  worktreeIds: [[OLD_ID, NEW_ID]],
  rootPaths: [UNC]
})

describe('wsl drive UNC renderer store keys', () => {
  it('re-keys a quick-open history scope, keeping its local route', () => {
    const route = { executionHostId: 'local' }
    expect(
      convertedQuickOpenHistoryScope(
        JSON.stringify([route, OLD_ID, '//wsl/ubuntu/mnt/c/src/app']),
        keys
      )
    ).toBe(JSON.stringify([route, NEW_ID, 'c:/src/app']))
    expect(
      convertedQuickOpenHistoryScope(
        JSON.stringify([{ executionHostId: 'ssh:box' }, OLD_ID, '//wsl/ubuntu/mnt/c/src/app']),
        keys
      )
    ).toBeNull()
  })

  it('re-keys file view preferences and CSV widths inside the converted folder', () => {
    const fileKey = JSON.stringify([OLD_ID, 'local', null, `${UNC}\\data.csv`])
    const converted = JSON.stringify([NEW_ID, 'local', null, String.raw`C:\src\app\data.csv`])
    expect(convertedFileViewPreferenceKey(fileKey, keys)).toBe(converted)
    expect(convertedCsvColumnWidthsKey(JSON.stringify([fileKey, ',']), keys)).toBe(
      JSON.stringify([converted, ','])
    )
    expect(
      convertedFileViewPreferenceKey(JSON.stringify(['r2::x', 'local', null, `${UNC}\\a`]), keys)
    ).toBeNull()
  })

  it('moves a notebook choice to the drive path and keeps its interpreter', () => {
    const environment = { path: '/mnt/c/src/app/.venv/bin/python', name: '.venv' }
    expect(convertedNotebookEnvironment(`${UNC}\\a.ipynb`, environment, keys)).toEqual([
      String.raw`C:\src\app\a.ipynb`,
      environment
    ])
    expect(
      convertedNotebookEnvironment(
        String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\other\a.ipynb`,
        environment,
        keys
      )
    ).toBeNull()
  })
})
