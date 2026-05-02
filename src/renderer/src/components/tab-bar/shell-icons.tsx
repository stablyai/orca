import React from 'react'

export type WindowsShell = 'powershell.exe' | 'cmd.exe' | 'wsl.exe'

// Why: the "+" dropdown and per-tab tab strip both need a visual distinction
// between PowerShell, CMD, and WSL sessions. Stock lucide glyphs don't
// differentiate — every session rendered as the same generic chevron. These
// hand-crafted icons (derived from the official brand marks and redrawn as
// small currentColor-aware paths so they inherit the tab's text color) make
// each shell identifiable at a glance without shipping a heavier brand-asset
// package like simple-icons. The generic (macOS/Linux) terminal fallback uses
// the same colored-tile treatment so the tab strip reads as a consistent set
// of badges rather than a monochrome lucide glyph next to colorful brand
// marks.

function PowerShellIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1.5" y="3" width="21" height="18" rx="2.5" fill="#2E74B5" />
      <path
        d="M6.5 7.3l6.2 4.7-6.2 4.7-1.2-1.2 4.6-3.5-4.6-3.5z"
        fill="#ffffff"
        fillRule="nonzero"
      />
      <rect x="12.5" y="15.3" width="5" height="1.4" rx="0.4" fill="#ffffff" />
    </svg>
  )
}

function CmdIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1.5" y="3" width="21" height="18" rx="2.5" fill="#1F1F1F" />
      <path d="M5.8 8l4 4-4 4-1.1-1.1L7.7 12 4.7 9.1z" fill="#ffffff" />
      <rect x="10.5" y="15" width="8" height="1.4" rx="0.4" fill="#ffffff" />
    </svg>
  )
}

function WslIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // Text-based mark. A full Tux silhouette at 14px is unreadable and a rough
  // hand-drawn version is worse than a clean "WSL" typographic tile, which
  // still reads as distinct from PowerShell/CMD at a glance.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1.5" y="3" width="21" height="18" rx="2.5" fill="#F4B400" />
      <text
        x="12"
        y="15.2"
        textAnchor="middle"
        fontSize="7"
        fontWeight="800"
        fill="#1F1F1F"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        WSL
      </text>
    </svg>
  )
}

function GenericTerminalIcon({ size = 14 }: { size?: number }): React.JSX.Element {
  // Why: matches the tile treatment of PowerShell/CMD/WSL so the tab strip
  // reads as a consistent set of badges instead of a flat monochrome chevron.
  // Uses black/white (same palette as the CmdIcon) so generic mac/linux
  // sessions stay visually neutral — the colorful brand tiles are reserved
  // for shells that actually have a brand identity.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <rect x="1.5" y="3" width="21" height="18" rx="2.5" fill="#000000" />
      <path
        d="M6 7.5 L11.5 12 L6 16.5"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M12.5 16.5 L18 16.5"
        stroke="#ffffff"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

export function ShellIcon({
  shell,
  size = 14
}: {
  shell: string | null | undefined
  size?: number
}): React.JSX.Element {
  const normalized = (shell ?? '').toLowerCase()
  if (normalized === 'powershell.exe' || normalized === 'pwsh.exe') {
    return <PowerShellIcon size={size} />
  }
  if (normalized === 'cmd.exe') {
    return <CmdIcon size={size} />
  }
  if (normalized === 'wsl.exe' || normalized.startsWith('wsl')) {
    return <WslIcon size={size} />
  }
  return <GenericTerminalIcon size={size} />
}
