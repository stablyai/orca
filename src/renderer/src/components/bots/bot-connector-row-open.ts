// Whether each connector row is open, kept for the session: leaving the Connectors tab or the bot
// and coming back finds every row as the owner left it.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

type RowOpen = {
  open: boolean
  /** The row's last `defaultOpen`, so one that turns true while the row is away still opens it. */
  defaultOpen: boolean
}

/** A row's state, with the connector it belongs to. */
type KeptRow = RowOpen & { key: string | null }

// One small entry per connector row shown this session; never written to disk.
const rows = new Map<string, RowOpen>()

/** The connector a row stands for (host, bot and connector); none for rows not kept, e.g. Tools. */
export const BotConnectorRowKey = createContext<string | null>(null)

/**
 * A row's open state: as the owner left it this session, else `defaultOpen`. It opens again
 * whenever `defaultOpen` turns true (e.g. once a row needs the owner); closing is the owner's.
 */
export function useBotConnectorRowOpen(
  defaultOpen: boolean
): readonly [boolean, (open: boolean | ((open: boolean) => boolean)) => void] {
  const key = useContext(BotConnectorRowKey)
  const kept = (): KeptRow => ({
    key,
    ...((key ? rows.get(key) : undefined) ?? { open: defaultOpen, defaultOpen })
  })
  const [row, setRow] = useState<KeptRow>(kept)
  // React re-renders at once with the adjusted row, before anything commits.
  if (row.key !== key) {
    // Still mounted but now another bot's (or host's) connector: start from that one's own state,
    // so neither bot's state leaks into the other.
    setRow(kept())
  } else if (defaultOpen !== row.defaultOpen) {
    setRow({ ...row, open: defaultOpen || row.open, defaultOpen })
  }
  useEffect(() => {
    if (row.key !== null) {
      rows.set(row.key, { open: row.open, defaultOpen: row.defaultOpen })
    }
  }, [row])
  const setOpen = useCallback((next: boolean | ((open: boolean) => boolean)) => {
    setRow((prev) => ({ ...prev, open: typeof next === 'function' ? next(prev.open) : next }))
  }, [])
  return [row.open, setOpen] as const
}

/** For tests: forget every row, as a new session would. */
export function forgetBotConnectorRowsOpen(): void {
  rows.clear()
}
