/** Chromium's reload is a silent no-op when nothing ever committed and no navigation is pending. */
export function browserGuestHasNothingToReload(guest: { url: string; loading: boolean }): boolean {
  return guest.url === '' && !guest.loading
}
