/** Let the process exit while `timer` is pending; DOM-typed builds (mobile) see a number with no unref. */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle: unknown = timer
  if (
    typeof handle === 'object' &&
    handle !== null &&
    'unref' in handle &&
    typeof handle.unref === 'function'
  ) {
    handle.unref()
  }
}
