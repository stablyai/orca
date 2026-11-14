import { useState, type ReactNode } from 'react'
import { ImageIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'

export function CommunityChangeCard({
  title,
  label,
  category,
  metadata,
  imageUrls,
  imageAlt,
  emptyPreview,
  badge,
  footer,
  action,
  number,
  changeId,
  onOpen
}: {
  title: string
  label: string
  category: ReactNode
  metadata: ReactNode
  imageUrls: readonly string[]
  imageAlt: string
  emptyPreview: ReactNode
  badge?: ReactNode
  footer: ReactNode
  action?: ReactNode
  number?: number
  changeId?: string
  onOpen: () => void
}): React.JSX.Element {
  const [failedImage, setFailedImage] = useState<string | null>(null)
  const image = imageUrls[0]
  return (
    <Card
      size="list"
      className="overflow-hidden"
      data-proposal={number}
      data-installed-change={changeId}
    >
      <button
        type="button"
        className="group block text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        aria-label={label}
      >
        <div className="relative flex h-48 items-center justify-center border-b border-border bg-muted/40 p-3">
          {image && failedImage !== image ? (
            <img
              src={image}
              alt={imageAlt}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-full object-contain"
              onError={() => setFailedImage(image)}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              {emptyPreview}
            </div>
          )}
          {badge && (
            <Badge variant="secondary" className="absolute top-3 left-3">
              {badge}
            </Badge>
          )}
          {imageUrls.length > 0 && (
            <Badge variant="secondary" className="absolute right-3 bottom-3">
              <ImageIcon className="size-3" />
              {imageUrls.length}
            </Badge>
          )}
        </div>
        <div className="p-4">
          <p className="text-2xs text-muted-foreground">{category}</p>
          <h3 className="mt-2 min-h-10 text-sm font-semibold leading-snug group-hover:underline">
            {title}
          </h3>
          <p className="mt-3 text-xs text-muted-foreground">{metadata}</p>
        </div>
      </button>
      <div className="mx-4 flex min-h-10 items-center justify-between gap-2 border-t border-border py-2">
        <span className="text-2xs text-muted-foreground">{footer}</span>
        {action}
      </div>
    </Card>
  )
}
