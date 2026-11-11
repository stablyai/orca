// Routines are parked in the desktop until they are folded into Automations. This one flag hides
// every desktop entry point: the Settings section and its search entries, Home's Routines button,
// and Home's Routine runs switch and rows. The control plane, public API, MCP tools and CLI keep
// working, so existing routines still run. Flip to true to bring the UI back as it was.
export const CLOUD_ROUTINES_UI_ENABLED: boolean = false
