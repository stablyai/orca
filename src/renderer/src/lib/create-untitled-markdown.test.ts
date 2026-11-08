import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUntitledMarkdownFile } from './create-untitled-markdown'

import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

describe('createUntitledMarkdownFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects captured ownership without a current-generation assertion', async () => {
    await expect(
      createUntitledMarkdownFile('/repo', 'wt-1', undefined, LOCAL, {
        operationProvenance: {} as never
      })
    ).rejects.toThrow("Couldn't verify which host owns this file")
  })
})
