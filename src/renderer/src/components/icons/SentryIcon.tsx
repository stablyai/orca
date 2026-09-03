import { ShieldAlert } from 'lucide-react'

export function SentryIcon({ className }: { className?: string }): React.JSX.Element {
  return <ShieldAlert className={className} aria-hidden />
}
