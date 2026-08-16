// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

describe('NativeChatToolRun', () => {
  it('uses the shared clean label for a desktop tool row', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'Read',
        input: '{"file_path":"src/index.ts","offset":10}'
      }
    ]

    render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(screen.getByTitle('src/index.ts')).toHaveTextContent('src/index.ts')
    expect(screen.queryByTitle('{"file_path":"src/index.ts","offset":10}')).toBeNull()
  })
})
