import React, { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'

type MermaidBlockProps = {
  content: string
  isDark: boolean
}

let initialized = false

/**
 * Renders a mermaid diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function MermaidBlock({ content, isDark }: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Lazy init: configure mermaid once on first render rather than at import
    // time to avoid slowing down app startup.
    const theme = isDark ? 'dark' : 'default'
    if (!initialized) {
      mermaid.initialize({ startOnLoad: false, theme })
      initialized = true
    } else {
      mermaid.initialize({ startOnLoad: false, theme })
    }

    let cancelled = false

    const render = async (): Promise<void> => {
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Invalid mermaid syntax')
          // Mermaid leaves an error element in the DOM on failure — clean it up.
          const errorEl = document.getElementById(`d${`mermaid-${id}`}`)
          errorEl?.remove()
        }
      }
    }

    void render()
    return () => {
      cancelled = true
    }
  }, [content, isDark, id])

  if (error) {
    return (
      <div className="mermaid-block">
        <div className="mermaid-error">Diagram error: {error}</div>
        <pre>
          <code>{content}</code>
        </pre>
      </div>
    )
  }

  return <div className="mermaid-block" ref={containerRef} />
}
