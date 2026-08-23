import { describe, expect, it } from 'vitest'
import { arbitratePetPose } from './pet-pose-arbitration'

describe('arbitratePetPose', () => {
  it('shows the locomotion row while pacing, even when the agent state is idle', () => {
    // Pacing with an idle/breathing row playing reads as gliding, not walking.
    expect(arbitratePetPose('idle', true, null)).toEqual({ animation: 'running', pacing: true })
    expect(arbitratePetPose('running', true, null)).toEqual({ animation: 'running', pacing: true })
  })

  it('halts the pacing for states that are poses, not travel', () => {
    expect(arbitratePetPose('waiting', true, null)).toEqual({ animation: 'waiting', pacing: false })
    expect(arbitratePetPose('jumping', true, null)).toEqual({ animation: 'jumping', pacing: false })
    expect(arbitratePetPose('review', true, null)).toEqual({ animation: 'review', pacing: false })
  })

  it('keeps the agent state row when the pet is not walking anyway', () => {
    expect(arbitratePetPose('idle', false, null)).toEqual({ animation: 'idle', pacing: false })
    expect(arbitratePetPose('waiting', false, null)).toEqual({
      animation: 'waiting',
      pacing: false
    })
  })

  it('passes drag rows through untouched — the drag owns the pet', () => {
    expect(arbitratePetPose('running-right', true, null)).toEqual({
      animation: 'running-right',
      pacing: false
    })
    expect(arbitratePetPose('running-left', false, null)).toEqual({
      animation: 'running-left',
      pacing: false
    })
  })

  it('lets the fall phase override everything, agent state included', () => {
    // Mid-air is mid-air: no agent state should put the pet back on its feet.
    expect(arbitratePetPose('running', true, 'falling')).toEqual({
      animation: 'falling',
      pacing: false
    })
    expect(arbitratePetPose('waiting', true, 'downed')).toEqual({
      animation: 'downed',
      pacing: false
    })
    expect(arbitratePetPose('idle', true, 'rising')).toEqual({
      animation: 'rising',
      pacing: false
    })
  })
})
