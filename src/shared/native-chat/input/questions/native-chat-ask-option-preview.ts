/** The option's preview as Claude shows it: a non-blank string, kept verbatim. */
export function askOptionPreview(option: unknown): string | null {
  return option &&
    typeof option === 'object' &&
    'preview' in option &&
    typeof option.preview === 'string' &&
    // Why not trim(): history rescans run this per option, and trim copies the whole preview.
    /\S/.test(option.preview)
    ? option.preview
    : null
}
