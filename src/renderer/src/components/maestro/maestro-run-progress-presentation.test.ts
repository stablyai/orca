import { describe, expect, it } from 'vitest'
import type { MaestroRunResource } from '../../../../shared/maestro-run-resource'
import { humanResourceDetail } from './maestro-run-progress-presentation'

describe('humanResourceDetail', () => {
  it('explains how to recover an unavailable managed Browser page', () => {
    const resource: MaestroRunResource = {
      kind: 'browser',
      reference: 'browser:page-1',
      title: 'Browser',
      detail: 'Browser is unavailable.',
      state: 'error'
    }

    expect(humanResourceDetail(resource)).toBe(
      'The owning host cannot verify this managed Browser page. Open a new Browser page from the Canvas to continue.'
    )
  })

  it('preserves a specific Browser failure explanation', () => {
    const resource: MaestroRunResource = {
      kind: 'browser',
      reference: 'browser:page-1',
      title: 'Browser',
      detail: 'The Browser belongs to another workspace.',
      state: 'error'
    }

    expect(humanResourceDetail(resource)).toBe('The Browser belongs to another workspace.')
  })
})
