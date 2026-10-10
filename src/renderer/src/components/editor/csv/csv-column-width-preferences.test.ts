// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  CSV_COLUMN_WIDTHS_STORAGE_KEY,
  readCsvColumnWidths,
  writeCsvColumnWidths,
  remapCsvColumnWidths
} from './csv-column-width-preferences'
import { buildFileViewPreferenceKey } from '../file-view-preference-storage'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

it('persists widths through remounts and isolates the same path by owner', () => {
  const owner = { worktreeId: 'folder:a', filePath: '/repo/a.csv' }
  const local = buildFileViewPreferenceKey(owner)
  const paired = buildFileViewPreferenceKey({ ...owner, runtimeEnvironmentId: 'paired' })
  const ssh = buildFileViewPreferenceKey({ ...owner, externalSshTargetId: 'ssh' })
  writeCsvColumnWidths(local, { 0: 180, 2: 300 })
  expect(readCsvColumnWidths(local)).toEqual({ 0: 180, 2: 300 })
  expect(readCsvColumnWidths(paired)).toEqual({})
  expect(readCsvColumnWidths(ssh)).toEqual({})
  writeCsvColumnWidths(local, {})
  expect(readCsvColumnWidths(local)).toEqual({})
})

it('ignores corrupted indexes, malformed values and unsupported widths', () => {
  localStorage.setItem(
    CSV_COLUMN_WIDTHS_STORAGE_KEY,
    JSON.stringify({
      file: {
        '0': 160,
        '1': '80',
        '-1': 160,
        '02': 160,
        '2.5': 160,
        '4096': 160,
        '3': 20,
        '4': 1300,
        '5': null
      }
    })
  )
  expect(readCsvColumnWidths('file')).toEqual({ 0: 160 })
  localStorage.setItem(CSV_COLUMN_WIDTHS_STORAGE_KEY, 'invalid json')
  expect(readCsvColumnWidths('file')).toEqual({})
})

it('bounds retained file preferences and tolerates storage failure', () => {
  for (let index = 0; index <= 100; index += 1) {
    writeCsvColumnWidths(`file-${index}`, { 0: 160 })
  }
  expect(readCsvColumnWidths('file-0')).toEqual({})
  expect(readCsvColumnWidths('file-100')).toEqual({ 0: 160 })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota')
  })
  expect(() => writeCsvColumnWidths('file', { 0: 180 })).not.toThrow()
})

it('moves widths with column identity through insertion, deletion and reordering', () => {
  const widths = { 0: 180, 2: 300 }
  expect(remapCsvColumnWidths(widths, 3, { kind: 'insert-column', at: 1, label: '' })).toEqual({
    0: 180,
    3: 300
  })
  expect(remapCsvColumnWidths(widths, 3, { kind: 'delete-columns', columns: [1] })).toEqual({
    0: 180,
    1: 300
  })
  expect(remapCsvColumnWidths(widths, 3, { kind: 'move-column', from: 2, to: 0 })).toEqual({
    0: 300,
    1: 180
  })
})
