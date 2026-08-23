// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
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

  it('renders structured apply_patch changes as a reviewable diff instead of JSON', () => {
    const blocks: NativeChatBlock[] = [
      {
        type: 'tool-call',
        name: 'apply_patch',
        input: {
          changes: [
            {
              path: '/repo/src/app.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-before\n+after'
            }
          ]
        }
      }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(screen.getByText('+after')).toBeInTheDocument()
    expect(screen.getByText('-before')).toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('renders evidence-shaped projected patches as colored diffs without changes JSON', () => {
    const item: AgentJournalRenderItem = {
      itemId: 'apply-patch',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'apply_patch',
        input: {
          changes: [
            {
              path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-before\n+after'
            }
          ]
        },
        state: 'completed'
      }
    }
    const projected = projectStructuredItemToNativeChat(item)

    expect(projected).not.toBeNull()
    const { container } = render(
      <NativeChatToolRun blocks={projected?.blocks ?? []} expandSignal />
    )

    expect(screen.getByText('+after')).toHaveClass(
      'bg-emerald-500/10',
      'text-[var(--git-decoration-added)]'
    )
    expect(screen.getByText('-before')).toHaveClass(
      'bg-rose-500/10',
      'text-[var(--git-decoration-deleted)]'
    )
    expect(container).not.toHaveTextContent('"changes"')
    expect(container.querySelector('pre')).toBeNull()
  })
})
