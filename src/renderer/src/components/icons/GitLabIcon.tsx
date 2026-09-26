import React from 'react'

// Why: lucide-react ships no GitLab glyph and the style guide restricts icons to
// lucide, so the brand mark lives here the way LinearIcon and JiraIcon do.
// Path data: Simple Icons (CC0).
export function GitLabIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M23.6004 9.5927l-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.2902-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.405L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.4617 1.8633 1.4999 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4999-1.1321 2.4616-1.8633 5.0062-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </svg>
  )
}
