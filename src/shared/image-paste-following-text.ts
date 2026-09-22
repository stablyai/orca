// One space after a bracketed image paste so later typed/sent text cannot glue
// onto the path (`…pngadd` → `…png add`). Desktop terminal drops already do this
// when an image is followed by a non-image path.
export const IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR = ' '

export function separateImagePasteFromFollowingText(
  framedImagePaste: string,
  followedByNonImageInput: boolean
): string {
  return followedByNonImageInput
    ? `${framedImagePaste}${IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR}`
    : framedImagePaste
}

export function imagePasteWritesFollowedByText(
  framedImagePastes: readonly string[],
  followedByText: boolean
): string[] {
  return framedImagePastes.map((paste, index) =>
    separateImagePasteFromFollowingText(
      paste,
      index === framedImagePastes.length - 1 && followedByText
    )
  )
}
