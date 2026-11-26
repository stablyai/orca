import React, { useEffect, useRef } from 'react'

/**
 * One polite live region for the search pane. It always mounts empty and gets its text after mount,
 * because screen readers skip a region that already holds text when it appears (a restored draft).
 */
export function SearchAnnouncer({ text }: { text: string }): React.JSX.Element {
  const regionRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (regionRef.current) {
      regionRef.current.textContent = text
    }
  }, [text])
  return (
    <span
      ref={regionRef}
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-search-announcer=""
    />
  )
}
