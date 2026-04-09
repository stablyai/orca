import React, { useEffect, useId, useRef, useState } from 'react'
import mermaid from 'mermaid'
import DOMPurify from 'dompurify'

type MermaidBlockProps = {
  content: string
  isDark: boolean
}

// Why: mermaid.render() manipulates global DOM state (element IDs, internal
// parser state). Running multiple renders concurrently causes race conditions
// where one render can clobber another's temporary DOM node. Serializing all
// render calls through a single promise chain avoids this.
let renderQueue: Promise<void> = Promise.resolve()

/**
 * Renders a mermaid diagram string as SVG. Falls back to raw source with an
 * error banner if the syntax is invalid — never breaks the rest of the preview.
 */
export default function MermaidBlock({ content, isDark }: MermaidBlockProps): React.JSX.Element {
  const id = useId().replace(/:/g, '_')
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const theme = isDark ? 'dark' : 'default'
    // Re-initialize on every effect so the theme stays in sync with the
    // current appearance. mermaid.initialize() is cheap and idempotent.
    mermaid.initialize({ startOnLoad: false, theme })

    let cancelled = false

    const render = async (): Promise<void> => {
      try {
        const { svg } = await mermaid.render(`mermaid-${id}`, content)
        if (!cancelled && containerRef.current) {
          // Why: although mermaid uses DOMPurify internally, we add an explicit
          // sanitization pass as defense-in-depth against XSS in case upstream
          // behaviour changes or a mermaid version ships without sanitization.
          containerRef.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true }
          })
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

    // Serialize render calls through a module-level queue to avoid race
    // conditions from concurrent mermaid.render() invocations.
    renderQueue = renderQueue.then(render, render)
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
