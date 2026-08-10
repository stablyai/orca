/* @vitest-environment happy-dom */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RoomCompletedActivity } from '../../../../shared/rooms'
import { RoomCompletedActivityTimeline } from './RoomActivityTimeline'

describe('RoomCompletedActivityTimeline', () => {
  it('keeps completed work expandable and opens captured file diffs', () => {
    const activity: RoomCompletedActivity = {
      state: 'completed',
      startedAt: 1_000,
      completedAt: 129_000,
      messages: [
        {
          id: 'commentary',
          role: 'reasoning',
          source: 'transcript',
          timestamp: 2_000,
          blocks: [{ type: 'text', text: 'Inspecting the implementation.' }]
        },
        {
          id: 'edit',
          role: 'assistant',
          source: 'transcript',
          timestamp: 3_000,
          blocks: [
            {
              type: 'tool-call',
              name: 'apply_patch',
              input: {
                patch: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch'
              }
            }
          ]
        }
      ]
    }

    render(<RoomCompletedActivityTimeline activity={activity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 2m 8s' }))
    expect(screen.getByText('Inspecting the implementation.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Edited files' }))
    fireEvent.click(screen.getByRole('button', { name: /src\/app\.ts/ }))

    expect(screen.getByRole('heading', { name: 'src/app.ts' })).toBeTruthy()
    expect(screen.getByText('-old')).toBeTruthy()
    expect(screen.getByText('+new')).toBeTruthy()
  })

  it('shows provider-independent tool labels', () => {
    const activity: RoomCompletedActivity = {
      state: 'completed',
      startedAt: 1_000,
      completedAt: 2_000,
      messages: [
        {
          id: 'web',
          role: 'assistant',
          source: 'transcript',
          timestamp: 1_500,
          blocks: [{ type: 'tool-call', name: 'webrun', input: { search_query: [] } }]
        }
      ]
    }

    render(<RoomCompletedActivityTimeline activity={activity} />)
    fireEvent.click(screen.getByRole('button', { name: 'Worked for 1s' }))
    fireEvent.click(screen.getByRole('button', { name: 'Searched the web' }))
    expect(screen.getByText('Search the web')).toBeTruthy()
  })
})
