import type { CustomAgent } from '../../../../shared/types'

type CustomAgentIconProps = {
  agent: CustomAgent
  /** Pixel size of the rendered icon. Defaults to 14 (combobox density). */
  size?: number
}

/**
 * Render a custom agent's identity glyph. Falls back through:
 *   1. user-provided iconUrl
 *   2. Google favicon service for a declared domain
 *   3. a colored tile with the label's first letter
 *
 * Shared by the agent combobox and the terminal tab leading icon so icon
 * updates made in settings propagate to every surface that shows the glyph.
 */
export function CustomAgentIcon({ agent, size = 14 }: CustomAgentIconProps): React.JSX.Element {
  if (agent.iconUrl) {
    return (
      <img
        src={agent.iconUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  if (agent.faviconDomain) {
    return (
      <img
        src={`https://www.google.com/s2/favicons?domain=${agent.faviconDomain}&sz=64`}
        width={size}
        height={size}
        alt=""
        aria-hidden
        style={{ borderRadius: 2 }}
      />
    )
  }
  return <CustomAgentLetterTile agent={agent} size={size} />
}

/**
 * SVG letter tile used when no image source is available. Sized via the SVG
 * viewBox so callers can render at any pixel size without re-styling.
 */
function CustomAgentLetterTile({
  agent,
  size
}: {
  agent: CustomAgent
  size: number
}): React.JSX.Element {
  const letter = agent.label.charAt(0).toUpperCase()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="text-current"
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
