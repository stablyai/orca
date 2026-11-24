import React from 'react'
import { cn } from '../../../lib/class-names'

export function PiIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG from pi.dev/favicon.svg; text-current prevents Select from forcing muted color on the π glyph.
  return (
    <svg
      height={size}
      width={size}
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('text-current', className)}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}

export function OmpIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const gradientId = `${React.useId().replace(/:/g, '')}-omp-gradient`

  // SVG from omp.sh’s transparent homepage mark; its favicon includes a dark square.
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(0.7 0.24 340)" />
          <stop offset=".5" stopColor="oklch(0.62 0.21 295)" />
          <stop offset="1" stopColor="oklch(0.81 0.14 200)" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
    </svg>
  )
}

export function KiloIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG from Kilo-Org/kilocode:packages/kilo-vscode/assets/icons/kilo-light.svg; retain brand yellow/black for legibility in both themes.
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ borderRadius: 2 }}
    >
      <path d="M512 0H0V512H512V0Z" fill="black" />
      <path
        d="M322 377H377V421H307.857L278 391.143V322H322V377ZM421 307.857L391.143 278H322V322L377 322V377H421V307.857ZM234 278H190V322H234V278ZM91 391.143L120.857 421H234V377H135V278H91V391.143ZM371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172ZM135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91ZM234 91H190V140.5H234V91Z"
        fill="#FAF74F"
      />
    </svg>
  )
}

export function AiderIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG from aider.chat/assets/icons/safari-pinned-tab.svg; text-current prevents Select from forcing muted color.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 436 436"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn('text-current', className)}
    >
      <g transform="translate(0,436) scale(0.1,-0.1)" fill="currentColor" stroke="none">
        <path d="M0 2180 l0 -2180 2180 0 2180 0 0 2180 0 2180 -2180 0 -2180 0 0 -2180z m2705 1818 c20 -20 28 -121 30 -398 l2 -305 216 -5 c118 -3 218 -8 222 -12 3 -3 10 -46 15 -95 5 -48 16 -126 25 -172 17 -86 17 -81 -17 -233 -14 -67 -13 -365 2 -438 21 -100 22 -159 5 -247 -24 -122 -24 -363 1 -458 23 -88 23 -213 1 -330 -9 -49 -17 -109 -17 -132 l0 -43 203 0 c111 0 208 -4 216 -9 10 -6 18 -51 27 -148 8 -76 16 -152 20 -168 7 -39 -23 -361 -37 -387 -10 -18 -21 -19 -214 -16 -135 2 -208 7 -215 14 -22 22 -33 301 -21 501 6 102 8 189 5 194 -8 13 -417 12 -431 -2 -12 -12 -8 -146 8 -261 8 -55 8 -95 1 -140 -6 -35 -14 -99 -17 -143 -9 -123 -14 -141 -41 -154 -18 -8 -217 -11 -679 -11 l-653 0 -11 33 c-31 97 -43 336 -27 533 5 56 6 113 2 128 l-6 26 -194 0 c-211 0 -252 4 -261 28 -12 33 -17 392 -6 522 15 186 -2 174 260 180 115 3 213 8 217 12 4 4 1 52 -5 105 -7 54 -17 130 -22 168 -7 56 -5 91 11 171 10 55 22 130 26 166 4 36 10 72 15 79 7 12 128 15 665 19 l658 5 8 30 c5 18 4 72 -3 130 -12 115 -7 346 11 454 10 61 10 75 -1 82 -8 5 -300 9 -650 9 l-636 0 -27 25 c-18 16 -26 34 -26 57 0 18 -5 87 -10 153 -10 128 5 449 22 472 5 7 26 13 46 15 78 6 1281 3 1287 -4z" />
        <path d="M1360 1833 c0 -5 -1 -164 -3 -356 l-2 -347 625 -1 c704 -1 708 -1 722 7 5 4 7 20 4 38 -29 141 -32 491 -6 595 9 38 8 45 -7 57 -15 11 -139 13 -675 14 -362 0 -658 -3 -658 -7z" />
      </g>
    </svg>
  )
}

export function CopilotIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG from Primer Octicons copilot-16; GitHub’s 2025 guidance deprecated the standalone mascot.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn('text-current', className)}
      fill="currentColor"
    >
      <path d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z" />
      <path d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z" />
    </svg>
  )
}

export function OpenCodeIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG geometry from opencode.ai/favicon.svg’s 512 canvas; currentColor supports both themes and a square viewBox matches siblings.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn('text-current', className)}
    >
      <path d="M320 224V352H192V224H320Z" fill="currentColor" fillOpacity="0.28" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** The MiniMax gradient mark used for mcode entries in agent pickers and tabs. */
export function MiniMaxIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  const gradientId = `${React.useId().replace(/:/g, '')}-minimax-gradient`

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 37 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="15.5"
          x2="36.9143"
          y2="15.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="var(--color-git-graph-lane-2)" />
          <stop offset="1" stopColor="var(--color-git-graph-base-ref)" />
        </linearGradient>
      </defs>
      <path
        d="M17.5802 3.08155C17.5802 2.35036 16.987 1.75702 16.2589 1.75702C15.5309 1.75702 14.9377 2.35171 14.9377 3.08155V25.0348C14.9377 26.7337 13.5586 28.1164 11.8639 28.1164C10.1693 28.1164 8.79008 26.7337 8.79008 25.0348V10.9503C8.79008 10.2191 8.19688 9.62575 7.46886 9.62575C6.74085 9.62575 6.14765 10.2204 6.14765 10.9503V16.9201C6.14765 18.619 4.76846 20.0016 3.07381 20.0016C1.37915 20.0016 0 18.619 0 16.9201V14.7563C0 14.2711 0.392318 13.8778 0.876312 13.8778C1.36031 13.8778 1.75262 14.2711 1.75262 14.7563V16.9201C1.75262 17.6513 2.34579 18.2446 3.07381 18.2446C3.80182 18.2446 4.39502 17.6499 4.39502 16.9201V10.9503C4.39502 9.25138 5.77421 7.86874 7.46886 7.86874C9.16352 7.86874 10.5427 9.25138 10.5427 10.9503V25.0348C10.5427 25.766 11.1359 26.3593 11.8639 26.3593C12.5919 26.3593 13.1851 25.7646 13.1851 25.0348V16.4227V3.08155C13.1851 1.38265 14.5643 0 16.2589 0C17.9536 0 19.3328 1.38265 19.3328 3.08155V21.2599C19.3328 21.7451 18.9405 22.1384 18.4565 22.1384C17.9725 22.1384 17.5802 21.7451 17.5802 21.2599V3.08155ZM33.8405 7.86874C32.1458 7.86874 30.7666 9.25138 30.7666 10.9503V22.7155C30.7666 23.4467 30.1734 24.0401 29.4454 24.0401C28.7174 24.0401 28.1242 23.4454 28.1242 22.7155V3.08155C28.1242 1.38265 26.745 0 25.0504 0C23.3557 0 21.9766 1.38265 21.9766 3.08155V28.0042C21.9766 28.7354 21.3834 29.3287 20.6553 29.3287C19.9273 29.3287 19.3341 28.734 19.3341 28.0042V24.9186C19.3341 24.4334 18.9418 24.0401 18.4578 24.0401C17.9738 24.0401 17.5815 24.4334 17.5815 24.9186V28.0042C17.5815 29.7031 18.9607 31.0857 20.6553 31.0857C22.35 31.0857 23.7292 29.7031 23.7292 28.0042V3.08155C23.7292 2.35036 24.3224 1.75702 25.0504 1.75702C25.7784 1.75702 26.3716 2.35171 26.3716 3.08155V22.7155C26.3716 24.4144 27.7508 25.7971 29.4454 25.7971C31.1401 25.7971 32.5193 24.4144 32.5193 22.7155V10.9503C32.5193 10.2191 33.1125 9.62575 33.8405 9.62575C34.5685 9.62575 35.1617 10.2204 35.1617 10.9503V21.2599C35.1617 21.7451 35.554 22.1384 36.038 22.1384C36.522 22.1384 36.9143 21.7451 36.9143 21.2599V10.9503C36.9143 9.25138 35.5351 7.86874 33.8405 7.86874Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  )
}

export function AgentLetterIcon({
  letter,
  size = 14,
  className
}: {
  letter: string
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn('text-current', className)}
    >
      <rect width="14" height="14" rx="3" fill="currentColor" fillOpacity="0.2" />
      <text
        x="7"
        y="10.5"
        textAnchor="middle"
        fontSize="8.5"
        fill="currentColor"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}
