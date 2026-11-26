// Separate later text from pasted image paths (pngadd → png add), matching desktop mixed-path drops.
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
