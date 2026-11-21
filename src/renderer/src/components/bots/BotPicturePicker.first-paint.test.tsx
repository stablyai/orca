// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AvatarImageAgentStatus } from '../../../../shared/avatar-generation/avatar-generation-contract'
import { BotPicturePicker } from './BotPicturePicker'
import {
  refreshAvatarCapability,
  resetAvatarCapabilityForTest
} from './avatar-generation-capability-store'

const GROK: AvatarImageAgentStatus = { agent: 'grok', status: 'ready' }

/** Main's agent check, answered when the test says so. */
function stubCheck(): (agents: AvatarImageAgentStatus[]) => Promise<void> {
  let answer: (agents: AvatarImageAgentStatus[]) => void = () => {}
  Reflect.set(window, 'api', {
    avatarGeneration: {
      capability: () =>
        new Promise((resolve) => {
          answer = (agents) => resolve({ agents })
        }),
      generate: async () => ({ ok: false, error: 'failed' }),
      cancel: async () => {}
    }
  })
  return async (agents) => {
    await act(async () => answer(agents))
  }
}

function faces(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-roledescription="carousel"] > [data-face]')].map(
    (face) => `${face.getAttribute('data-face')}:${face.getAttribute('data-position')}`
  )
}

function Picker(): React.JSX.Element {
  return (
    <TooltipProvider>
      <BotPicturePicker
        value={{ kind: 'mascot', index: 4 }}
        custom={null}
        onChange={() => {}}
        onUpload={() => {}}
      />
    </TooltipProvider>
  )
}

describe('BotPicturePicker faces', () => {
  beforeEach(resetAvatarCapabilityForTest)
  afterEach(cleanup)

  it('has its final faces at first render when the agent check answered before it opened', async () => {
    const answer = stubCheck()
    refreshAvatarCapability()
    await answer([GROK])
    const answerAgain = stubCheck()
    const { container } = render(<Picker />)
    const first = faces(container)
    expect(first).toContain('generate:neighbour')
    // Opening checks again; the same answer changes nothing.
    await answerAgain([GROK])
    expect(faces(container)).toEqual(first)
  })

  it('keeps its first faces when the first check answers only after it opened', async () => {
    const answer = stubCheck()
    const { container } = render(<Picker />)
    const first = faces(container)
    expect(first.some((face) => face.startsWith('generate:'))).toBe(false)
    await answer([GROK])
    expect(faces(container)).toEqual(first)
  })
})
