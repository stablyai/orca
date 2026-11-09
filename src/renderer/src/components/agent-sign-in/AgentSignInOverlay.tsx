/** The pane-covering scrim the sign-in card sits on, matching the sleeping-pane overlay. */
export function AgentSignInOverlay({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-agent-sign-in-overlay=""
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 p-4 font-sans motion-safe:animate-in motion-safe:fade-in-0"
    >
      {children}
    </div>
  )
}
