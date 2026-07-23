export const MAX_CUSTOM_PET_FILE_BYTES = 64 * 1024 * 1024

// Why: sprite processing holds decoded image, canvas, ImageData, PNG, and
// optional bitmap copies at once, so encoded bytes alone are not a safe bound.
export const MAX_CUSTOM_PET_SHEET_PIXELS = 4 * 1024 * 1024
export const MAX_CUSTOM_PET_SHEET_DIMENSION = 8_192
export const MAX_CUSTOM_PET_DETECTED_FRAMES = 128

export function isCustomPetSheetSizeSafe(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_CUSTOM_PET_SHEET_DIMENSION &&
    height <= MAX_CUSTOM_PET_SHEET_DIMENSION &&
    width * height <= MAX_CUSTOM_PET_SHEET_PIXELS
  )
}
