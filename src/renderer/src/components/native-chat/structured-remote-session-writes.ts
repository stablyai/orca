// Whether a structured chat owned by a paired host may be written to from this client.
//
// The reader advertisement ships ahead of the switch that makes remote creation legal, so for now
// a paired chat is a transcript: no send, no approval, no option change, and above all no hold.
// The hold is the one read-shaped call that is not a read — it opens the durable record on the
// other machine and hands its session a provider child back — so a pane that took one would start
// work on a host nobody is watching.
export function structuredRemoteSessionWritesEnabled(): boolean {
  return false
}
