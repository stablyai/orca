import React, { useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import {
  readPrefersReducedMotion,
  usePrefersReducedMotion
} from '@/hooks/theme/usePrefersReducedMotion'
import type { Bot } from '../../../../shared/bot-types'
import { botGroupFaces, type BotGroupFace } from '../../../../shared/bots/bot-group-face-layout'
import { BotAvatar, BotAvatarTile } from './BotAvatar'

// The sidebar row's picture at four times its size.
const SCALE = 4
const POP = 'cubic-bezier(0.34, 1.56, 0.64, 1)'
const SETTLE_MS = 420

type Face = BotGroupFace<Bot> | { key: 'empty'; face: null; x: number; y: number; size: number }

/** The group's picture as the sidebar will draw it; faces pop in and out as members change. */
export function BotGroupFaceCluster({ members }: { members: readonly Bot[] }): React.JSX.Element {
  const reduced = usePrefersReducedMotion()
  const faces: Face[] =
    members.length > 0
      ? botGroupFaces(members, (bot) => bot.id)
      : [{ key: 'empty', face: null, x: 4, y: 4, size: 20 }]
  const signature = faces.map((face) => face.key).join(' ')
  // Faces just dropped stay until they have shrunk away.
  const [shown, setShown] = useState({ signature, faces })
  const [leaving, setLeaving] = useState<Face[]>([])
  if (shown.signature !== signature) {
    const gone = shown.faces.filter((old) => !faces.some((face) => face.key === old.key))
    setShown({ signature, faces })
    setLeaving((current) => [
      ...current.filter((old) => !faces.some((face) => face.key === old.key)),
      ...(reduced ? [] : gone)
    ])
  }
  return (
    <span className="relative block size-28" aria-hidden>
      {leaving.map((face) => (
        <ClusterFace
          key={`leaving-${face.key}`}
          face={face}
          z={0}
          reduced={reduced}
          onLeft={() => setLeaving((current) => current.filter((old) => old.key !== face.key))}
        />
      ))}
      {faces.map((face, index) => (
        <ClusterFace key={face.key} face={face} z={index + 1} reduced={reduced} />
      ))}
    </span>
  )
}

/** One circle; it pops in on mount, or shrinks away and reports back when given onLeft. */
function ClusterFace({
  face,
  z,
  reduced,
  onLeft
}: {
  face: Face
  z: number
  reduced: boolean
  onLeft?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const leftRef = useRef(onLeft)
  const more = face.face && 'more' in face.face ? face.face.more : null
  const lastMore = useRef(more)
  useEffect(() => {
    const el = ref.current
    if (!el || readPrefersReducedMotion()) {
      leftRef.current?.()
      return
    }
    if (!leftRef.current) {
      el.animate(
        [
          { transform: 'scale(0.3)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1 }
        ],
        { duration: SETTLE_MS, easing: POP }
      )
      return
    }
    const leave = el.animate(
      [
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(0.3)', opacity: 0 }
      ],
      { duration: 220, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
    )
    leave.onfinish = () => leftRef.current?.()
  }, [])
  useEffect(() => {
    // "+N" bumps when N changes.
    if (more === lastMore.current) {
      return
    }
    lastMore.current = more
    if (!readPrefersReducedMotion()) {
      ref.current?.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
        { duration: 260, easing: 'ease-out' }
      )
    }
  }, [more])
  return (
    <span
      ref={ref}
      className="absolute flex rounded-full"
      style={{
        left: face.x * SCALE,
        top: face.y * SCALE,
        width: face.size * SCALE,
        height: face.size * SCALE,
        zIndex: z,
        // A ring in the dialog's own colour parts overlapping faces.
        boxShadow: face.face ? '0 0 0 4px var(--dialog-surface)' : undefined,
        transition: reduced
          ? undefined
          : ['left', 'top', 'width', 'height'].map((p) => `${p} ${SETTLE_MS}ms ${POP}`).join(', ')
      }}
    >
      {face.face === null ? (
        <span className="flex size-full items-center justify-center rounded-full border border-dashed border-input text-muted-foreground">
          <Users className="size-8" strokeWidth={1.5} />
        </span>
      ) : 'member' in face.face ? (
        <BotAvatar
          bot={face.face.member}
          className="size-full rounded-full"
          style={{ fontSize: 28 }}
        />
      ) : (
        <BotAvatarTile
          src={null}
          fallback={`+${face.face.more}`}
          className="size-full rounded-full text-xl font-medium text-muted-foreground tabular-nums"
        />
      )}
    </span>
  )
}
