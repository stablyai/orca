import { PictureInPicture2 } from 'lucide-react'

export type DetachedWindow = {
  isDetached: boolean
  onMove: () => void
  disabled: boolean
  localOnly: boolean
}

export function DetachedTerminalTabIndicator(): React.JSX.Element {
  return <PictureInPicture2 aria-hidden className="mr-1 size-3 shrink-0 text-muted-foreground" />
}
