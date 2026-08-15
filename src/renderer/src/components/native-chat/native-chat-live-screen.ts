/** The live screen candidates for a pty, best first.
 *
 * Three sources, because none covers every case:
 *  - the snapshot's current frame — the alternate screen itself while a TUI
 *    owns it, the only place Claude's status line exists;
 *  - the snapshot's normal buffer, where the scrolled-back banner lives;
 *  - the mounted xterm, the only source for remote/SSH ptys the API misses. */
export async function collectNativeChatLiveScreens(args: {
  ptyId: string | null
  readTerminalScreen?: () => string | null
}): Promise<(string | null)[]> {
  const screens: (string | null)[] = []
  if (args.ptyId && window.api?.pty?.getMainBufferSnapshot) {
    try {
      const snapshot = await window.api.pty.getMainBufferSnapshot(args.ptyId, { scrollbackRows: 0 })
      screens.push(snapshot?.data ?? null, snapshot?.scrollbackAnsi ?? null)
    } catch {
      // The mounted xterm below covers this host.
    }
  }
  screens.push(args.readTerminalScreen?.() ?? null)
  return screens
}

/** Keeps the first candidate that `parse` accepts.
 *
 * Why parse-driven rather than picking one screen: a stale buffer reads back as
 * perfectly good text that simply lacks what the caller needs, so falling back
 * only when the READ is empty would strand us on it and report nothing. */
export async function readNativeChatLiveScreen<T>(args: {
  ptyId: string | null
  readTerminalScreen?: () => string | null
  parse: (screen: string | null | undefined) => T | null
}): Promise<T | null> {
  for (const screen of await collectNativeChatLiveScreens(args)) {
    const parsed = args.parse(screen)
    if (parsed) {
      return parsed
    }
  }
  return null
}
