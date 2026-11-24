// One arrow for the cursor drawn over pages and the badge on the agent's tab.
// The tip sits at (3, 2) in the 22x24 box.
export const AGENT_CURSOR_GLYPH_PATH =
  'M3 2.6v16.1c0 .6.7.9 1.1.5l3.9-3.6 2.5 5.8c.2.4.6.6 1 .4l2.4-1c.4-.2.6-.6.4-1l-2.5-5.7 5.3-.3c.6 0 .9-.8.4-1.2L4.1 2.1C3.6 1.7 3 2 3 2.6Z'

export function AgentCursorGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 22 24" className={className} aria-hidden="true" focusable="false">
      <path
        d={AGENT_CURSOR_GLYPH_PATH}
        className="fill-foreground stroke-background"
        strokeWidth={2.5}
        strokeLinejoin="round"
        paintOrder="stroke"
      />
    </svg>
  )
}
