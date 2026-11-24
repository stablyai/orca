// The Generate face of a bot not yet made (New bot, Import): kept by the dialog, above the picker's
// popover, so a run goes on with it closed and, after Create, follows the bot made.
import { useRef } from 'react'
import { useGenerateFace, type GenerateFace } from './AvatarGenerateFace'
import { noteBotPictureChoice } from './bot-picture-ops'
import { useBotAvatarIntakeState, type BotAvatarIntake } from './use-bot-avatar-intake'
import type { NewBotPicture } from './use-new-bot-picture'
import type { Bot } from '../../../../shared/bot-types'

function useNewBotGenerateFace(picture: NewBotPicture, intake: BotAvatarIntake): GenerateFace {
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
    () => {
      generateTurn.current = intake.claim()
    },
    { owner: () => ({ kind: 'draft', key: picture.choiceKey }), background: true }
  )
}

/** For an intake's `onTake`: a picture taken in is a choice for the dialog's bot from the moment it
 *  starts being read. */
function draftPictureTake(pictureKey: string): () => () => void {
  return () => {
    noteBotPictureChoice(pictureKey)
    return () => {}
  }
}

/** New bot's picture intake, for pictures pasted, dropped or uploaded in the dialog and the picture
 *  popover alike (none while Create runs, which has taken the picture), and its Generate face, which
 *  takes turns with it. */
export function useNewBotDialogPicture(
  picture: NewBotPicture,
  creating: boolean
): { intake: BotAvatarIntake; face: GenerateFace } {
  const intake = useBotAvatarIntakeState({
    onPicture: picture.placeUpload,
    undoable: false,
    onTake: draftPictureTake(picture.choiceKey),
    disabled: creating
  })
  return { intake, face: useNewBotGenerateFace(picture, intake) }
}

/** Create takes the picture now: a run still going, unless a newer choice was made, follows the bot the
 *  returned call's create makes, and goes back to the dialog when it makes none. */
export function followedByPicture(
  face: GenerateFace,
  target: Parameters<GenerateFace['handOff']>[0]
): <T extends Bot | null>(create: Promise<T>) => Promise<T> {
  const handOff = face.handOff(target)
  return (create) =>
    create.then(
      (bot) => {
        if (bot) {
          handOff?.created(bot)
        } else {
          handOff?.failed()
        }
        return bot
      },
      (error: unknown) => {
        handOff?.failed()
        throw error
      }
    )
}
