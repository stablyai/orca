import React, { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { Breakpoint } from '../../../../shared/debug-breakpoint-types'
import type { BreakpointDraft } from '@/store/slices/breakpoints'

export type BreakpointEditDialogFocusField = 'condition' | 'logMessage'

type BreakpointEditDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  line: number
  initialValue: Breakpoint | undefined
  focusField: BreakpointEditDialogFocusField
  onSubmit: (draft: BreakpointDraft) => void
}

export function BreakpointEditDialog({
  open,
  onOpenChange,
  line,
  initialValue,
  focusField,
  onSubmit
}: BreakpointEditDialogProps): React.JSX.Element {
  const [condition, setCondition] = useState(initialValue?.condition ?? '')
  const [hitCondition, setHitCondition] = useState(initialValue?.hitCondition ?? '')
  const [logMessage, setLogMessage] = useState(initialValue?.logMessage ?? '')
  const conditionInputRef = useRef<HTMLInputElement>(null)
  const logMessageInputRef = useRef<HTMLInputElement>(null)

  // Why: reseed from the breakpoint each time the dialog opens so a prior cancelled edit doesn't leak into the next open.
  useEffect(() => {
    if (!open) {
      return
    }
    setCondition(initialValue?.condition ?? '')
    setHitCondition(initialValue?.hitCondition ?? '')
    setLogMessage(initialValue?.logMessage ?? '')
    const target = focusField === 'logMessage' ? logMessageInputRef.current : conditionInputRef.current
    target?.focus()
  }, [open, initialValue, focusField])

  const submit = (): void => {
    onSubmit({
      condition: condition.trim() || undefined,
      hitCondition: hitCondition.trim() || undefined,
      logMessage: logMessage.trim() || undefined
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate('debug.breakpointEditDialog.title', 'Edit Breakpoint · Line {{value0}}', {
              value0: line
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'debug.breakpointEditDialog.description',
              'Break only when a condition is true, after a number of hits, or log a message instead of stopping.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="breakpoint-condition-input">
              {translate('debug.breakpointEditDialog.conditionLabel', 'Condition')}
            </Label>
            <Input
              id="breakpoint-condition-input"
              ref={conditionInputRef}
              value={condition}
              placeholder={translate(
                'debug.breakpointEditDialog.conditionPlaceholder',
                'e.g. i === 10'
              )}
              onChange={(e) => setCondition(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="breakpoint-hit-count-input">
              {translate('debug.breakpointEditDialog.hitCountLabel', 'Hit Count')}
            </Label>
            <Input
              id="breakpoint-hit-count-input"
              value={hitCondition}
              placeholder={translate('debug.breakpointEditDialog.hitCountPlaceholder', 'e.g. >= 5')}
              onChange={(e) => setHitCondition(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="breakpoint-log-message-input">
              {translate('debug.breakpointEditDialog.logMessageLabel', 'Log Message')}
            </Label>
            <Input
              id="breakpoint-log-message-input"
              ref={logMessageInputRef}
              value={logMessage}
              placeholder={translate(
                'debug.breakpointEditDialog.logMessagePlaceholder',
                'e.g. value is {value}'
              )}
              onChange={(e) => setLogMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submit()
                }
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('debug.breakpointEditDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={submit}>
            {translate('debug.breakpointEditDialog.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
