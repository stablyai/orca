import { useCallback, useRef, useState } from 'react'
import { toPng } from 'html-to-image'
import { Check, Copy, Share2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../ui/dialog'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { ShareUsageCard, type ShareUsageCardProps } from './ShareUsageCard'

type ShareUsageButtonProps = ShareUsageCardProps

function XIcon(): React.JSX.Element {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

export function ShareUsageButton(props: ShareUsageButtonProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [capturing, setCapturing] = useState(false)

  const captureToClipboard = useCallback(async () => {
    if (!cardRef.current || capturing) {
      return
    }
    setCapturing(true)
    try {
      const dataUrl = await toPng(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: undefined
      })
      await window.api.ui.writeClipboardImage(dataUrl)
      return true
    } finally {
      setCapturing(false)
    }
  }, [capturing])

  const handleCopy = useCallback(async () => {
    const ok = await captureToClipboard()
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [captureToClipboard])

  const handleShareToX = useCallback(async () => {
    const { provider, summary, range } = props
    const providerName = provider === 'claude' ? 'Claude' : 'Codex'
    const rangeLabel =
      range === '7d'
        ? 'last 7 days'
        : range === '30d'
          ? 'last 30 days'
          : range === '90d'
            ? 'last 90 days'
            : 'all-time'

    const totalTokens =
      provider === 'claude'
        ? summary.inputTokens + summary.outputTokens
        : (summary as unknown as { totalTokens: number }).totalTokens

    const cost = summary.estimatedCostUsd
    const costStr =
      cost === null ? 'n/a' : cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`

    const fmtTokens = (v: number): string => {
      if (v >= 1_000_000) {
        return `${(v / 1_000_000).toFixed(1)}M`
      }
      if (v >= 1_000) {
        return `${(v / 1_000).toFixed(1)}k`
      }
      return v.toLocaleString()
    }

    const lines = [
      `My ${rangeLabel} ${providerName} usage via @orca_build`,
      '',
      `${fmtTokens(totalTokens)} tokens · ${costStr} est. cost`,
      '',
      'github.com/stablyai/orca'
    ]
    const url = `https://x.com/intent/post?text=${encodeURIComponent(lines.join('\n'))}`
    await window.api.shell.openUrl(url)
  }, [props])

  return (
    <Dialog>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Share usage">
                <Share2 className="size-3.5" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            Share
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="max-w-fit" showCloseButton>
        <DialogHeader>
          <DialogTitle>Share usage</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          <ShareUsageCard ref={cardRef} {...props} />
          <div className="flex w-full max-w-[480px] gap-2">
            <Button onClick={() => void handleCopy()} disabled={capturing} className="flex-1">
              {copied ? (
                <>
                  <Check className="mr-2 size-4" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 size-4" />
                  Copy image
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleShareToX()}
              disabled={capturing}
              className="flex-1"
            >
              <span className="mr-2">
                <XIcon />
              </span>
              Share on X
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
