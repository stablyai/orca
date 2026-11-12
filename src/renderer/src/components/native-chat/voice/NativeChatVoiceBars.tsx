// Relative heights: the middle bars stand tallest, like the voice tip's waveform.
const BAR_HEIGHTS = [45, 80, 100, 65]

/** Voice mode's mark: bars that move while someone speaks and rest otherwise. */
export function NativeChatVoiceBars({
  moving,
  className = 'size-4'
}: {
  moving: boolean
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-moving={moving || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-0.5 ${className}`}
    >
      {BAR_HEIGHTS.map((height, index) => (
        <span
          key={height}
          className={`block w-0.5 rounded-full bg-current ${moving ? 'motion-safe:animate-waveform' : ''}`}
          style={{ height: `${height}%`, animationDelay: `${index * 0.15}s` }}
        />
      ))}
    </span>
  )
}
