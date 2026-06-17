import { useState } from 'react'

type TrelloAvatarProps = {
  avatarUrl?: string | null
  name?: string
  className?: string
}

export function TrelloAvatar({
  avatarUrl,
  name,
  className = 'size-7'
}: TrelloAvatarProps): React.JSX.Element {
  const [failedSources, setFailedSources] = useState<string[]>([])
  const primarySrc = avatarUrl ?? null
  const fallbackSrc = primarySrc?.endsWith('/50.png')
    ? primarySrc.replace('/50.png', '/30.png')
    : null
  const src =
    primarySrc && !failedSources.includes(primarySrc)
      ? primarySrc
      : fallbackSrc && !failedSources.includes(fallbackSrc)
        ? fallbackSrc
        : null
  if (src) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        className={`${className} shrink-0 rounded-full`}
        onError={() => {
          setFailedSources((current) => {
            if (!src || current.includes(src)) {
              return current
            }
            return [...current, src]
          })
        }}
      />
    )
  }
  return (
    <div
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground`}
    >
      {(name || 'T').slice(0, 1)}
    </div>
  )
}
