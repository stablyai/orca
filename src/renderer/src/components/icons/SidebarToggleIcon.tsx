import type React from 'react'

export function SidebarToggleIcon({
  side,
  size = 16,
  className
}: {
  side: 'left' | 'right'
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={className}
    >
      <rect
        x="1.5"
        y="3.5"
        width="13"
        height="9"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      {side === 'left' ? (
        <path
          d="M3.7 3.5H6V12.5H3.7A2.2 2.2 0 0 1 1.5 10.3V5.7A2.2 2.2 0 0 1 3.7 3.5Z"
          fill="currentColor"
        />
      ) : (
        <path
          d="M12.3 3.5H10V12.5H12.3A2.2 2.2 0 0 0 14.5 10.3V5.7A2.2 2.2 0 0 0 12.3 3.5Z"
          fill="currentColor"
        />
      )}
    </svg>
  )
}
