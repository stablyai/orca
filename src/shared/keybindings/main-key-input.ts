/** Keys main handled that the page may never see: a modifier release, or a keydown main consumed. */
export type MainKeyInput =
  | {
      type: 'modifierUp'
      held: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
    }
  | { type: 'consumedKeyDown'; code: string }
