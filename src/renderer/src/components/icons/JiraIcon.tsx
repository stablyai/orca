export function JiraIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 -30.632388516510233 255.324 285.95638851651023"
      aria-hidden
      className={className}
      fill="currentColor"
    >
      {/* Why: flatten the official Jira product mark so it matches Orca's
      monochrome provider icons instead of rendering as a branded tile. */}
      <path d="M244.658 0H121.707a55.502 55.502 0 0 0 55.502 55.502h22.649V77.37c.02 30.625 24.841 55.447 55.466 55.467V10.666C255.324 4.777 250.55 0 244.658 0z" />
      <path d="M183.822 61.262H60.872c.019 30.625 24.84 55.447 55.466 55.467h22.649v21.938c.039 30.625 24.877 55.43 55.502 55.43V71.93c0-5.891-4.776-10.667-10.667-10.667z" />
      <path d="M122.951 122.489H0c0 30.653 24.85 55.502 55.502 55.502h22.72v21.867c.02 30.597 24.798 55.408 55.396 55.466V133.156c0-5.891-4.776-10.667-10.667-10.667z" />
    </svg>
  )
}
