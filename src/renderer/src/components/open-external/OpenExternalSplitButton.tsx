// A button that opens a page in the user's browser, with a chevron at its far right whose menu
// copies the exact URL instead (Neil's rule for every open-in-browser button: people paste sign-in
// and billing links into an incognito window or another browser profile). The main action is the
// caller's, unchanged; the chevron only ever copies.
import React, { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Link2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { buttonGroupVariants } from '@/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { copyExternalLink, type ExternalLinkSource } from './copy-external-link'

const COPIED_MS = 1500

type ButtonProps = React.ComponentProps<typeof Button>

export type OpenExternalSplitButtonProps = Omit<ButtonProps, 'onClick' | 'type' | 'asChild'> & {
  /**
   * What "Copy link" copies: the URL the main action opens, or how to mint it without opening.
   * Null (nothing to copy yet) renders the plain button, no chevron.
   */
  link: ExternalLinkSource | null
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** The wrapper (place it in the parent's layout); `className` styles the main button. */
  groupClassName?: string
  /**
   * Where the copied link works, when that's limited: a muted second line under "Copy link" and
   * the copied toast's description. Only loopback sign-in links set it (`SIGN_IN_LINK_HINT`).
   */
  copyHint?: string
}

export function OpenExternalSplitButton({
  link,
  onClick,
  groupClassName,
  copyHint,
  className,
  variant,
  size,
  disabled,
  children,
  ...buttonProps
}: OpenExternalSplitButtonProps): React.JSX.Element {
  const t = useTranslate()
  const [state, setState] = useState<'idle' | 'copying' | 'copied'>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
    }
  }, [])

  const copy = async (): Promise<void> => {
    if (state === 'copying' || !link) {
      return
    }
    setState('copying')
    const result = await copyExternalLink(link, copyHint)
    if (!mounted.current) {
      return
    }
    setState(result === 'copied' ? 'copied' : 'idle')
    if (result === 'copied') {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
      resetTimer.current = setTimeout(() => {
        if (mounted.current) {
          setState('idle')
        }
      }, COPIED_MS)
    }
  }

  const solid = variant === undefined || variant === 'default' || variant === 'destructive'
  const copyLabel = t('openExternal.copyLink', 'Copy link')
  if (!link) {
    return (
      <Button
        {...buttonProps}
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        className={className}
        onClick={onClick}
      >
        {children}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      {/* The group squares the inner corners; the chevron half is narrow, behind a 1px divider. */}
      <div
        role="group"
        data-slot="button-group"
        data-open-external-split
        className={cn(buttonGroupVariants({ split: solid ? 'solid' : 'subtle' }), groupClassName)}
      >
        <Button
          {...buttonProps}
          type="button"
          variant={variant}
          size={size}
          disabled={disabled}
          className={className}
          onClick={onClick}
        >
          {children}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant={variant}
            size={size}
            disabled={disabled}
            aria-label={t('openExternal.moreOptions', 'More link options')}
            aria-busy={state === 'copying' || undefined}
            data-open-external-chevron
          >
            {state === 'copied' ? (
              <Check aria-hidden />
            ) : state === 'copying' ? (
              <Loader2 aria-hidden className="motion-safe:animate-spin" />
            ) : (
              <ChevronDown aria-hidden />
            )}
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void copy()}>
          <Link2 aria-hidden />
          {copyHint ? (
            <span className="flex flex-col">
              <span>{copyLabel}</span>
              <span className="text-xs text-muted-foreground">{copyHint}</span>
            </span>
          ) : (
            copyLabel
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
