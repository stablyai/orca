import type { JSX, RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export function BrowserPricingStoryboard(props: {
  cardRef: RefObject<HTMLDivElement | null>
  ctaRef: RefObject<HTMLSpanElement | null>
  ringStarter: boolean
  ctaHighlighted: boolean
  ctaPressing: boolean
}): JSX.Element {
  return (
    <>
      <div className="text-[15px] font-bold leading-tight">
        {translate('auto.components.feature.wall.BrowserAnimatedVisual.9e0f530390', 'Pricing')}
      </div>
      <div className="h-2 w-4/5 rounded bg-foreground/10" />
      <div className="mt-1 grid grid-cols-2 gap-2.5">
        <PricingCard
          cardRef={props.cardRef}
          ctaRef={props.ctaRef}
          label={translate(
            'auto.components.feature.wall.BrowserAnimatedVisual.59ae327405',
            'Starter'
          )}
          cta="Try free"
          target
          ringActive={props.ringStarter}
          ctaHighlighted={props.ctaHighlighted}
          ctaPressing={props.ctaPressing}
        />
        <PricingCard
          label={translate('auto.components.feature.wall.BrowserAnimatedVisual.25f15c2219', 'Pro')}
          cta="Get Pro"
          highlighted
        />
      </div>
    </>
  )
}

function PricingCard(props: {
  label: string
  cta: string
  highlighted?: boolean
  target?: boolean
  ringActive?: boolean
  ctaHighlighted?: boolean
  ctaPressing?: boolean
  cardRef?: RefObject<HTMLDivElement | null>
  ctaRef?: RefObject<HTMLSpanElement | null>
}): JSX.Element {
  const ctaIsBranded = props.ctaHighlighted && !props.highlighted
  return (
    <div
      ref={props.cardRef}
      className="relative flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5"
    >
      {props.target ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute -inset-[3px] rounded-[10px] border-2 border-blue-500 bg-blue-500/10 transition-opacity duration-300',
            props.ringActive ? 'opacity-100' : 'opacity-0'
          )}
        />
      ) : null}
      <span className="text-[11.5px] font-semibold">{props.label}</span>
      <div className="h-1.5 w-3/5 rounded bg-foreground/10" />
      <div className="h-1.5 w-4/5 rounded bg-foreground/10" />
      <span
        ref={props.ctaRef}
        className={cn(
          'mt-1 inline-flex w-fit items-center rounded-md px-2 py-1 text-[11px] font-semibold transition-[background-color,color,box-shadow,transform] duration-300',
          props.highlighted
            ? 'bg-foreground text-background'
            : ctaIsBranded
              ? 'bg-blue-600 text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)]'
              : 'bg-foreground/[0.07] text-foreground',
          props.ctaPressing ? 'scale-[0.96]' : null
        )}
      >
        {props.cta}
      </span>
    </div>
  )
}
