import { describe, expect, it } from 'vitest'
import { formatTransferProgressHeading } from './transfer-progress-heading'

describe('formatTransferProgressHeading', () => {
  it('counts files while the drop is running', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 2,
        settled: false,
        doneCount: 0,
        cancelledCount: 1
      })
    ).toBe('Uploading 2 items')
  })

  it('says cancelled once everything stopped and nothing landed', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 2,
        settled: true,
        doneCount: 0,
        cancelledCount: 2
      })
    ).toBe('Upload cancelled')
  })

  it('does not let a cancel hide a failure when nothing landed', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 2,
        settled: true,
        doneCount: 0,
        cancelledCount: 1
      })
    ).toBe('Upload failed')
  })

  it('reports a partial drop by count', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 3,
        settled: true,
        doneCount: 1,
        cancelledCount: 2
      })
    ).toBe('Uploaded 1 of 3')
  })

  it('reports a clean finish', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 2,
        settled: true,
        doneCount: 2,
        cancelledCount: 0
      })
    ).toBe('Uploaded 2 items')
  })

  it('distinguishes a failure from a cancel', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 1,
        settled: true,
        doneCount: 0,
        cancelledCount: 0
      })
    ).toBe('Upload failed')
  })

  it('uses the singular for one file', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 1,
        settled: false,
        doneCount: 0,
        cancelledCount: 0
      })
    ).toBe('Uploading 1 item')
    expect(
      formatTransferProgressHeading({
        direction: 'upload',
        rowCount: 1,
        settled: true,
        doneCount: 1,
        cancelledCount: 0
      })
    ).toBe('Uploaded 1 item')
  })

  it('words a download the same way', () => {
    expect(
      formatTransferProgressHeading({
        direction: 'download',
        rowCount: 1,
        settled: false,
        doneCount: 0,
        cancelledCount: 0
      })
    ).toBe('Downloading 1 item')
    expect(
      formatTransferProgressHeading({
        direction: 'download',
        rowCount: 2,
        settled: true,
        doneCount: 0,
        cancelledCount: 2
      })
    ).toBe('Download cancelled')
  })
})
