export function TodoistIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      {/* Why: monochrome take on the Todoist mark (rounded tile with stacked checks). */}
      <path
        fillRule="evenodd"
        d="M4.5 2h15A2.5 2.5 0 0 1 22 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 19.5v-15A2.5 2.5 0 0 1 4.5 2Zm.9 6.6 3 1.75 9.2-5.3.9 1.55-10.1 5.85-3.9-2.3.9-1.55Zm0 4.2 3 1.75 9.2-5.3.9 1.55-10.1 5.85-3.9-2.3.9-1.55Zm0 4.2 3 1.75 9.2-5.3.9 1.55-10.1 5.85-3.9-2.3.9-1.55Z"
      />
    </svg>
  )
}
