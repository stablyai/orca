import { describe, expect, it } from 'vitest'
import { formatTerminalDropUploadHeading } from './terminal-drop-upload-heading'

describe('formatTerminalDropUploadHeading', () => {
  it('counts files while the drop is running', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 2,
        settled: false,
        doneCount: 0,
        cancelledCount: 1
      })
    ).toBe('Uploading 2 files to runtime')
  })

  it('says cancelled once everything stopped and nothing landed', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 2,
        settled: true,
        doneCount: 0,
        cancelledCount: 2
      })
    ).toBe('Upload cancelled')
  })

  it('reports a partial drop by count', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 3,
        settled: true,
        doneCount: 1,
        cancelledCount: 2
      })
    ).toBe('Uploaded 1 of 3 to runtime')
  })

  it('reports a clean finish', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 2,
        settled: true,
        doneCount: 2,
        cancelledCount: 0
      })
    ).toBe('Uploaded 2 files to runtime')
  })

  it('distinguishes a failure from a cancel', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 1,
        settled: true,
        doneCount: 0,
        cancelledCount: 0
      })
    ).toBe('Upload failed')
  })

  it('uses the singular for one file', () => {
    expect(
      formatTerminalDropUploadHeading({
        rowCount: 1,
        settled: false,
        doneCount: 0,
        cancelledCount: 0
      })
    ).toBe('Uploading 1 file to runtime')
  })
})
