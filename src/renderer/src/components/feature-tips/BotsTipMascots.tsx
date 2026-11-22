import { useEffect, useState, type JSX } from 'react'
import monkey from '@/assets/bot-mascot-cutouts/E1-cut.webp'
import penguin from '@/assets/bot-mascot-cutouts/A1-cut.webp'
import { on } from './bots-tip-pieces'

// Why: they rise once the dialog has settled from its 200 ms open.
const RISE_AFTER_MS = 260

const PAW_PATH =
  'M3 9c0-5 4-8 12-8s12 3 12 8c0 4-2 7-5 7-1.5 0-2.4-1-3.3-1s-1.8 1-3.7 1-2.8-1-3.7-1-1.8 1-3.3 1C5 16 3 13 3 9Z'

type Lid = { left: number; top: number; width: number; height: number }

/** Eyelids over each eye, in percent of the picture, closing together in a blink. */
function Lids({ lids, color, delay }: { lids: Lid[]; color: string; delay: string }): JSX.Element {
  return (
    <>
      {lids.map((lid) => (
        <i
          key={lid.left}
          className="bt-lid"
          style={{
            left: `${lid.left}%`,
            top: `${lid.top}%`,
            width: `${lid.width}%`,
            height: `${lid.height}%`,
            background: color,
            animationDelay: delay
          }}
        />
      ))}
    </>
  )
}

function Paw({
  left,
  width,
  height,
  rotate,
  fill,
  tapping
}: {
  left: number
  width: number
  height: number
  rotate: number
  fill: string
  tapping: boolean
}): JSX.Element {
  return (
    <span
      className="bt-paw"
      data-state={tapping ? 'tap' : 'rest'}
      style={{ left, top: 0, width, height, transform: `rotate(${rotate}deg)` }}
    >
      <span className="bt-paw-press">
        <i className="bt-paw-shadow" />
        <svg viewBox="0 0 30 18" preserveAspectRatio="none">
          <path d={PAW_PATH} fill={fill} />
          <path
            className="bt-paw-sheen"
            d="M6 6c2-2.6 5-3.6 9-3.6"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </span>
    </span>
  )
}

/**
 * Two of the bots peeking over the dialog's top edge: bodies behind it, paws over its edge. They
 * blink, and the monkey's paws tap as page 1's messages land. Still under reduced motion.
 */
export function BotsTipMascots({
  open,
  tapping,
  reducedMotion
}: {
  open: boolean
  tapping: boolean
  reducedMotion: boolean
}): JSX.Element {
  const [risen, setRisen] = useState(false)
  useEffect(() => {
    if (!open) {
      setRisen(false)
      return
    }
    if (reducedMotion) {
      setRisen(true)
      return
    }
    const id = window.setTimeout(() => setRisen(true), RISE_AFTER_MS)
    return () => window.clearTimeout(id)
  }, [open, reducedMotion])
  return (
    <div aria-hidden>
      <div className="bt-mascot-bodies" data-mascots {...on(risen)}>
        <span className="bt-mk bt-mk-monkey">
          <img src={monkey} alt="" draggable={false} />
          <Lids
            color="#fef5d8"
            delay="0s"
            lids={[
              { left: 35.63, top: 37.94, width: 12.16, height: 12.86 },
              { left: 75.73, top: 30.19, width: 11.91, height: 12.39 }
            ]}
          />
        </span>
        <span className="bt-mk bt-mk-penguin">
          <img src={penguin} alt="" draggable={false} />
          <Lids
            color="#fff4dc"
            delay="2.3s"
            lids={[
              { left: 33.15, top: 38.6, width: 10.68, height: 14.11 },
              { left: 70.21, top: 29.42, width: 10.02, height: 13.63 }
            ]}
          />
        </span>
      </div>
      <div className="bt-mascot-paws" data-mascots {...on(risen)}>
        <span className="bt-mk bt-mk-monkey-paws">
          <Paw left={0} width={30} height={18} rotate={-8} fill="#835137" tapping={tapping} />
          <Paw left={78} width={30} height={18} rotate={8} fill="#835137" tapping={tapping} />
        </span>
        <span className="bt-mk bt-mk-penguin-paws">
          <Paw left={0} width={26} height={16} rotate={-18} fill="#1a3251" tapping={false} />
        </span>
      </div>
    </div>
  )
}
