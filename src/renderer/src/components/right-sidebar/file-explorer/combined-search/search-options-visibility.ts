/** Text-match options stay out of the way until the user is searching. */
export function shouldShowSearchOptions(focused: boolean, query: string): boolean {
  return focused || query.length > 0
}
