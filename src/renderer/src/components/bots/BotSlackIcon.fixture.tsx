import { useEffect, useState } from 'react'
import { defineFixture, type ComponentFixture } from '../../component-fixtures/component-fixture'
import type { BotMascotId } from '../../../../shared/bot-avatar'
import type { BotAvatarOutfit } from '../../../../shared/bots/bot-avatar-outfit'
import { BotAvatar } from './BotAvatar'
import { BOT_MASCOT_URLS } from './bot-mascots'
import { drawBotSlackIcon } from './bot-slack-icon-raster'

type Look = { id: BotMascotId; color: string | null; outfit: BotAvatarOutfit | null }

// Each row: what Slack got before (the plain mascot), the in-app picture, and the exact 512 px PNG sent now.
function SlackIconRow({ look }: { look: Look }): React.JSX.Element {
  const [png, setPng] = useState<string | null>(null)
  useEffect(() => {
    void drawBotSlackIcon(look.id, look.color, look.outfit).then(setPng)
  }, [look])
  return (
    <div className="flex items-end gap-4">
      <figure className="flex flex-col items-center gap-1">
        <img src={BOT_MASCOT_URLS[look.id]} alt="" className="size-32 rounded-2xl" />
        <figcaption className="text-xs text-muted-foreground">Slack before</figcaption>
      </figure>
      <figure className="flex flex-col items-center gap-1">
        <BotAvatar
          bot={{
            id: look.id,
            hostId: 'local',
            name: look.id,
            avatar: `mascot:${look.id}`,
            avatarColor: look.color,
            avatarOutfit: look.outfit
          }}
          size="large"
          className="size-32 rounded-2xl"
        />
        <figcaption className="text-xs text-muted-foreground">In Orca</figcaption>
      </figure>
      <figure className="flex flex-col items-center gap-1">
        {png ? <img src={`data:image/png;base64,${png}`} alt="" className="size-64" /> : null}
        <figcaption className="text-xs text-muted-foreground">
          Slack after (the PNG sent, 512 px at 2x)
        </figcaption>
      </figure>
    </div>
  )
}

function row(look: Look): ComponentFixture {
  return defineFixture({
    width: 720,
    render: () => (
      <div className="p-3">
        <SlackIconRow look={look} />
      </div>
    ),
    // The outfit's art is read on first use; wait for it and the drawing.
    interact: () => new Promise((resolve) => setTimeout(resolve, 4000))
  })
}

export const colored = row({ id: 'A1', color: '#1f2126', outfit: null })
export const party = row({ id: 'B1', color: '#f4c4cf', outfit: 'party' })
export const reviewer = row({ id: 'E1', color: '#c5dfb5', outfit: 'reviewer' })
