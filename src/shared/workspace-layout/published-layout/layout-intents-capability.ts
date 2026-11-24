// Advertise layout-owner streaming/apply as one contract: snapshot then gapless epoch/seq frames, with reply frameSeq at or after the command’s effect.
// Resubscribe on gaps/epoch changes. Params add optional fields only; new command types need a new capability because older hosts refuse them.
// Without this capability desktops retain session.tabs mirrors, which hosts still serve.
export const LAYOUT_INTENTS_RUNTIME_CAPABILITY = 'layout.intents.v1' as const

// Show held newer-service panes only when the owner supports layout.reopenHeldPanes for the desktop’s Reopen action.
export const LAYOUT_REOPEN_HELD_PANES_CAPABILITY = 'layout.reopenHeldPanes.v1' as const
