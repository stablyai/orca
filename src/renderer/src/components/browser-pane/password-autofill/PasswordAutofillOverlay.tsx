import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type {
  BrowserPasswordDetectEvent,
  BrowserCredentialEntry
} from '../../../../../shared/browser-credential-types'
import { hostnameFromOrigin } from '../../../../../shared/browser-credential-hostname'

// Key icon is ~20px wide; anchor to the field's right edge and center vertically.
const KEY_SIZE = 20

type PasswordAutofillOverlayProps = {
  detect: BrowserPasswordDetectEvent | null
  matchesByFieldId: Record<string, BrowserCredentialEntry[]>
  onFill: (fieldId: string, entryId: string) => void
}

type FieldKeyButtonProps = {
  fieldId: string
  rect: { x: number; y: number; width: number; height: number }
  matches: BrowserCredentialEntry[]
  onFill: (fieldId: string, entryId: string) => void
}

function FieldKeyButton({
  fieldId,
  rect,
  matches,
  onFill
}: FieldKeyButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    // Why: positioned at the field's top-right corner inside the webview
    // overlay container, matching how annotation markers are anchored to
    // viewport-coord rects from the password bridge.
    <div
      className="absolute"
      style={{
        left: rect.x + rect.width - KEY_SIZE,
        top: rect.y + rect.height / 2 - KEY_SIZE / 2,
        pointerEvents: 'auto'
      }}
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                aria-label={translate(
                  'auto.components.browser.pane.PasswordAutofillOverlay.fillPassword',
                  'Fill password'
                )}
              >
                <KeyRound className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.browser.pane.PasswordAutofillOverlay.fillPassword',
              'Fill password'
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={4}>
          {matches.map((entry) => (
            <DropdownMenuItem
              key={entry.id}
              onSelect={() => {
                onFill(fieldId, entry.id)
                setOpen(false)
              }}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-xs font-medium">{entry.username}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {hostnameFromOrigin(entry.origin) ?? entry.origin}
                </span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Why: the outer div is pointer-events-none so the transparent overlay
// container does not block page interaction; only the key buttons themselves
// have pointer-events re-enabled, matching BrowserPane's annotation overlay
// approach.
export function PasswordAutofillOverlay({
  detect,
  matchesByFieldId,
  onFill
}: PasswordAutofillOverlayProps): React.JSX.Element | null {
  if (!detect) {
    return null
  }

  const fieldsWithMatches = detect.fields.filter(
    (field) => (matchesByFieldId[field.fieldId]?.length ?? 0) > 0
  )

  if (fieldsWithMatches.length === 0) {
    return null
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {fieldsWithMatches.map((field) => (
        <FieldKeyButton
          key={field.fieldId}
          fieldId={field.fieldId}
          rect={field.rect}
          matches={matchesByFieldId[field.fieldId]}
          onFill={onFill}
        />
      ))}
    </div>
  )
}
