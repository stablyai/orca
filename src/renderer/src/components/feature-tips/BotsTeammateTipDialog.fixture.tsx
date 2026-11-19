import type { JSX } from 'react'
import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { BotsTeammateTipDialog } from './BotsTeammateTipDialog'
import { BotsFleetStoryVisual } from './BotsFleetStoryVisual'
import { STORY_END } from './bots-fleet-story-timeline'

const tip = FEATURE_TIPS.find((item) => item.id === 'bots-teammate')
if (!tip) {
  throw new Error('Bots feature tip is missing')
}

export const fleetStory = defineFixture({
  render: () => (
    <BotsTeammateTipDialog
      open
      tip={tip}
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
    />
  )
})

function frozenStory(t: number, finished: boolean): JSX.Element {
  return (
    <div className="h-[27rem] w-[29.4rem] bg-muted/60">
      <BotsFleetStoryVisual
        playback={{
          t,
          playing: false,
          finished,
          reducedMotion: false,
          togglePause: () => {},
          replay: () => {}
        }}
      />
    </div>
  )
}

// The fleet mid-run: two agents done, two still working.
export const storyFleetRunning = defineFixture({ render: () => frozenStory(9.3, false) })

// The frame the story rests on after its last loop.
export const storyFinished = defineFixture({ render: () => frozenStory(STORY_END, true) })
