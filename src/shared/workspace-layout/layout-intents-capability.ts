// A layout-owner server's promise to a paired desktop (design H5). Advertised in status.get only
// by a build with ORCA_LAYOUT_OWNER=main, it versions this contract as one unit:
// - `layout.subscribe` sends a snapshot, then one records frame per change, carrying the stream's
//   `epoch` and gapless `seq` (workspace-layout-stream-frames.ts); a reader that sees a gap or a
//   new epoch resubscribes for a fresh snapshot.
// - `layout.apply` takes the window's commands for this server's workspaces; its reply's `frameSeq`
//   is at or after the frame holding the effect. Its params gain only optional fields: a new
//   command type is refused by an older server, so it needs a new capability.
// A desktop without it on the server keeps the session.tabs mirror, which the server still serves.
export const LAYOUT_INTENTS_RUNTIME_CAPABILITY = 'layout.intents.v1' as const
