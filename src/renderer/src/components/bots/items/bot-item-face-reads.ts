// What a long group's row faces read their pictures by: its rows mount as it scrolls, and each would
// read a picture again. `failures`: reads that failed while the group is shown, by bot and version,
// not read again until the group (or the panel) is reopened or the bot's host comes back. `offline`:
// the disconnected hosts, read once for the group, whose pictures aren't read meanwhile.
import { createContext } from 'react'

export type BotItemFaceReads = { failures: Set<string>; offline: ReadonlySet<string> }

export const BotItemFaceReadsContext = createContext<BotItemFaceReads | null>(null)
