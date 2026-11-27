import React, { useEffect, useRef, useState } from 'react'
import {
  loadAvatarPackAnimation,
  resolveAvatarPackAnimationFile,
  useAvatarPackCatalog
} from './avatar-pack-catalog'
import { AnimatedBotAvatarRenderer } from './AnimatedBotAvatarRenderer'
import type { AvatarAnimationState, AvatarKeyframedAnimation } from './avatar-pack-types'

export function AnimatedBotAvatar({
  pack,
  charIndex,
  state = 'idle',
  className,
  style,
  fallback
}: {
  pack: string
  charIndex: number
  state?: AvatarAnimationState
  className?: string
  style?: React.CSSProperties
  fallback?: React.ReactNode
}): React.JSX.Element {
  const { catalog, version } = useAvatarPackCatalog(true)
  const [animState, setAnimState] = useState<{
    key: string
    pack: string
    anim: AvatarKeyframedAnimation
  } | null>(null)
  const loadedKeyRef = useRef<string | null>(null)

  const fileName = catalog ? resolveAvatarPackAnimationFile(catalog, pack, charIndex, state) : null
  const targetKey = catalog && fileName ? `${version}:${pack}:${fileName}` : null

  useEffect(() => {
    if (!targetKey || !fileName) {
      loadedKeyRef.current = null
      return
    }
    if (loadedKeyRef.current === targetKey) {
      return
    }
    let active = true
    void loadAvatarPackAnimation(pack, fileName).then((loadedAnim) => {
      if (!active || !loadedAnim) {
        return
      }
      loadedKeyRef.current = targetKey
      setAnimState({ key: targetKey, pack, anim: loadedAnim })
    })
    return () => {
      active = false
    }
  }, [pack, fileName, targetKey])

  const anim = targetKey && animState?.pack === pack ? animState.anim : null

  if (!anim) {
    if (fallback !== undefined) {
      return <>{fallback}</>
    }
    return (
      <span
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...style
        }}
      />
    )
  }

  return (
    <AnimatedBotAvatarRenderer
      animation={anim}
      pack={animState?.pack ?? pack}
      className={className}
      style={style}
    />
  )
}
