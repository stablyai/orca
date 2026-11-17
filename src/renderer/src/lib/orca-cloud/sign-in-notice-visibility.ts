// Whether an inline Orca sign-in notice is on screen. A sign-in that didn't finish is said inline
// where one is shown; the toast is only for sign-ins started from a surface without one.
let mounted = 0

/** Call from an inline notice's mount effect; the returned function unregisters it. */
export function registerSignInNotice(): () => void {
  mounted += 1
  let registered = true
  return () => {
    if (registered) {
      registered = false
      mounted -= 1
    }
  }
}

export function isSignInNoticeVisible(): boolean {
  return mounted > 0
}
