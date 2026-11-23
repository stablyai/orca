// The Generate face of a bot not yet made (New bot, Import): kept by the dialog, above the picker's
// popover, so a run goes on with it closed and, after Create, follows the bot made.
import { useRef } from 'react'
import { useGenerateFace, type GenerateFace } from './AvatarGenerateFace'
import { noteBotPictureChoice } from './bot-picture-ops'
import type { BotAvatarIntake } from './use-bot-avatar-intake'
import type { NewBotPicture } from './use-new-bot-picture'

/** `intake`, when the dialog keeps one, gives Generate its turn among the pictures it takes in. */
export function useNewBotGenerateFace(
  picture: NewBotPicture,
  intake?: BotAvatarIntake
): GenerateFace {
  // A picture taken in after Generate was asked for keeps the slot.
  const generateTurn = useRef<(() => boolean) | null>(null)
  return useGenerateFace(
    (made, apply) => {
      const ownTurn = generateTurn.current?.() ?? true
      if (apply && ownTurn) {
        picture.onUpload(made.png, -1)
      }
      return ownTurn
    },
    picture.custom?.src
      ? { src: picture.custom.src, description: picture.custom.description }
      : null,
    intake
      ? () => {
          generateTurn.current = intake.claim()
        }
      : undefined,
    { owner: () => ({ kind: 'draft', key: picture.choiceKey }), background: true }
  )
}

/** For an intake's `onTake`: a picture taken in is a choice for the dialog's bot from the moment it
 *  starts being read. */
export function draftPictureTake(pictureKey: string): () => () => void {
  return () => {
    noteBotPictureChoice(pictureKey)
    return () => {}
  }
}
