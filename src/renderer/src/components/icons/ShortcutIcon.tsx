export function ShortcutIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className={className} fill="currentColor">
      {/* Why: flatten the official Shortcut zigzag mark so it matches Orca's
      monochrome provider icons instead of rendering as a branded tile. */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18.2765 8.46875H39.8392L30.0769 19.183L39.652 28.7301L29.7873 39.5561L8.15918 39.5506L17.9624 28.7915L8.42517 19.2828L18.2765 8.46875ZM19.7228 30.5467L13.8141 37.0315L26.2301 37.0346L19.7228 30.5467ZM29.2139 36.498L21.3993 28.7067L28.4005 21.0229L36.2151 28.8147L29.2139 36.498ZM26.6401 19.2677L19.6388 26.9516L11.8619 19.1979L18.8627 11.5129L26.6401 19.2677ZM28.3166 17.4277L34.183 10.9893H21.8593L28.3166 17.4277Z"
      />
    </svg>
  )
}
