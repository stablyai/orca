// The sidebar's opt-in shape picture: live only while its bot works and motion is allowed, so an
// idle row paints nothing per frame; otherwise the static SVG.
import { useEffect, useRef } from 'react'
import { mountAvatar } from 'open-bot-avatar/dom'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { BOT_SHAPE, botShapeColor } from './bot-shape-picture'

export function AnimatedBotShape({
  src,
  color,
  state
}: {
  src: string
  color: string | null | undefined
  state: 'idle' | 'working'
}): React.JSX.Element {
  const reduced = usePrefersReducedMotion()
  const live = !reduced && state === 'working' && BOT_SHAPE !== null
  const host = useRef<HTMLSpanElement>(null)
  const fill = botShapeColor(color)

  useEffect(() => {
    if (!live || !host.current || !BOT_SHAPE) {
      return
    }
    const mounted = mountAvatar(host.current, {
      definition: BOT_SHAPE,
      color: fill,
      state: 'working',
      label: '',
      reducedMotion: false
    })
    return () => mounted.destroy()
  }, [live, fill])

  return live ? (
    <span ref={host} data-bot-shape="live" className="relative size-full" />
  ) : (
    <img
      src={src}
      alt=""
      draggable={false}
      data-bot-shape="still"
      className="size-full object-cover"
    />
  )
}
