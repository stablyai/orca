import { describe, expect, it } from 'vitest'
import type { PRCheckAnnotation, PRCheckJob } from '../../../../shared/github/check-types'
import {
  formatAnnotationsForClipboard,
  formatCheckRunOutputForClipboard,
  formatJobsForClipboard
} from './check-run-clipboard-text'

describe('check run clipboard text', () => {
  it('formats all output sections in display order', () => {
    expect(
      formatCheckRunOutputForClipboard({
        title: 'Build failed',
        summary: 'One test failed.',
        text: 'Run the suite locally.'
      })
    ).toBe('Build failed\n\nOne test failed.\n\nRun the suite locally.')

    expect(
      formatCheckRunOutputForClipboard({ title: null, summary: 'Summary only', text: null })
    ).toBe('Summary only')
  })

  it('formats annotations with localized missing-path labels and separators', () => {
    const annotations: PRCheckAnnotation[] = [
      {
        path: 'src/main.ts',
        startLine: 10,
        endLine: 10,
        annotationLevel: 'failure',
        title: 'Type error',
        message: 'Expected string',
        rawDetails: 'Actual: number'
      },
      {
        path: null,
        startLine: null,
        endLine: null,
        annotationLevel: null,
        title: null,
        message: 'Workflow failed',
        rawDetails: null
      }
    ]

    expect(formatAnnotationsForClipboard(annotations, 'Anotacion')).toBe(
      'src/main.ts:10\nfailure\nType error\nExpected string\nActual: number\n\nAnotacion\nWorkflow failed'
    )
  })

  it('formats jobs with localized unknown states and log excerpts', () => {
    const jobs: PRCheckJob[] = [
      {
        id: 1,
        name: 'unit',
        status: null,
        conclusion: 'failure',
        startedAt: null,
        completedAt: null,
        url: null,
        logTail: 'AssertionError: expected true',
        steps: [
          {
            name: 'test',
            status: null,
            conclusion: null,
            startedAt: null,
            completedAt: null
          }
        ]
      },
      {
        id: 2,
        name: 'deploy',
        status: null,
        conclusion: null,
        startedAt: null,
        completedAt: null,
        url: null,
        logTail: null,
        steps: []
      }
    ]

    expect(formatJobsForClipboard(jobs, 'desconocido')).toBe(
      'unit: failure\ntest: desconocido\nAssertionError: expected true\n\ndeploy: desconocido'
    )
  })
})
