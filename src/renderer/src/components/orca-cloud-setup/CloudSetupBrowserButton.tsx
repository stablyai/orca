// A setup step's browser hop ("Continue in browser"). With a link source, its chevron offers "Copy
// link": the same page, minted the same way, for another browser or profile.
import type React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'

export function CloudSetupBrowserButton({
  label,
  busy,
  onClick,
  link
}: {
  label: string
  busy: boolean
  onClick: () => void
  link?: ExternalLinkSource | null
}): React.JSX.Element {
  return (
    <OpenExternalSplitButton link={link ?? null} onClick={onClick} disabled={busy}>
      {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
      {label}
      <ExternalLink aria-hidden />
    </OpenExternalSplitButton>
  )
}
