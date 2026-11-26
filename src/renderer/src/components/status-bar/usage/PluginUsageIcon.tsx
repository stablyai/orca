import { useState } from 'react'
import { Gauge } from 'lucide-react'

export function PluginUsageIcon({
  src,
  size = 13
}: {
  src?: string
  size?: number
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || src === failedSrc) {
    return <Gauge size={size} className="shrink-0" aria-hidden />
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      decoding="async"
      className="shrink-0 object-contain"
      onError={() => setFailedSrc(src)}
    />
  )
}
