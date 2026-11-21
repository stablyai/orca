import { defineFixture, type ComponentFixture } from '../../component-fixtures/component-fixture'
import { BOT_MASCOT_IDS } from '../../../../shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BotAvatar } from './BotAvatar'

// One outfit on every mascot, at the profile size (128 px) and the sidebar's (36 px), on the default
// and a dark tile: the sheet to check new outfit art against its mock.
function OutfitSheet({ outfit }: { outfit: BotAvatarOutfit }): React.JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-4 p-4">
      {BOT_MASCOT_IDS.map((id) => (
        <div key={id} className="flex flex-col items-center gap-2">
          <span className="text-xs text-muted-foreground">{id}</span>
          <BotAvatar
            bot={{ id, hostId: 'local', name: id, avatar: `mascot:${id}`, avatarOutfit: outfit }}
            size="large"
            className="size-32 rounded-2xl"
          />
          <div className="flex gap-2">
            <BotAvatar
              bot={{ id, hostId: 'local', name: id, avatar: `mascot:${id}`, avatarOutfit: outfit }}
              className="size-9 rounded-lg"
            />
            <BotAvatar
              bot={{
                id,
                hostId: 'local',
                name: id,
                avatar: `mascot:${id}`,
                avatarColor: '#1f2126',
                avatarOutfit: outfit
              }}
              className="size-9 rounded-lg"
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// The outfit's art is read on first use; wait for it and the pictures it dresses.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 4000))

function sheet(outfit: BotAvatarOutfit): ComponentFixture {
  return defineFixture({
    width: 760,
    render: () => <OutfitSheet outfit={outfit} />,
    interact: settle
  })
}

export const tie = sheet('tie')
export const detective = sheet('detective')
export const hardHat = sheet('hard-hat')
export const reviewer = sheet('reviewer')
export const nightShift = sheet('night-shift')
export const artist = sheet('artist')
export const scientist = sheet('scientist')
export const party = sheet('party')
