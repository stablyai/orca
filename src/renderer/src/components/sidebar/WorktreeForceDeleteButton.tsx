import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { ButtonGroup } from '../ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

// Why: Sonner hides a toast either behind a collapsed stack or past its visible-toast limit.
function isHiddenInToastStack(toastElement: Element): boolean {
  return (
    toastElement.getAttribute('data-visible') === 'false' ||
    (toastElement.getAttribute('data-expanded') === 'false' &&
      toastElement.getAttribute('data-front') === 'false')
  )
}

export function WorktreeForceDeleteButton({
  toastId,
  onForceDelete,
  onAlwaysForceDelete,
  onSavingChange,
  size = 'sm',
  disabled = false,
  buttonRef,
  fullWidth = false,
  menuSide,
  moreActionsLabel,
  alwaysForceDeleteLabel,
  alwaysForceDeleteTooltip,
  children
}: {
  toastId?: string
  onForceDelete: () => void
  onAlwaysForceDelete?: () => Promise<void>
  onSavingChange?: (saving: boolean) => void
  size?: 'sm' | 'default'
  disabled?: boolean
  buttonRef?: Ref<HTMLButtonElement>
  fullWidth?: boolean
  menuSide?: 'top' | 'bottom'
  moreActionsLabel?: string
  alwaysForceDeleteLabel?: string
  alwaysForceDeleteTooltip?: string
  children?: ReactNode
}): React.JSX.Element {
  const [isSaving, setIsSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const isToastHidden = (): boolean => {
    const toastElement = groupRef.current?.closest('[data-sonner-toast]')
    return toastElement ? isHiddenInToastStack(toastElement) : false
  }
  useEffect(() => {
    const toastElement = menuOpen ? groupRef.current?.closest('[data-sonner-toast]') : null
    if (!toastElement) {
      return
    }
    // Why: Sonner can hide this toast while its portaled menu would stay open over the app.
    const observer = new MutationObserver(() => {
      if (isHiddenInToastStack(toastElement)) {
        setMenuOpen(false)
      }
    })
    observer.observe(toastElement, {
      attributeFilter: ['data-expanded', 'data-front', 'data-visible']
    })
    return () => observer.disconnect()
  }, [menuOpen])
  const forceDelete = (): void => {
    if (toastId) {
      toast.dismiss(toastId)
    }
    onForceDelete()
  }
  const alwaysForceDelete = async (): Promise<void> => {
    if (!onAlwaysForceDelete) {
      return
    }
    setIsSaving(true)
    onSavingChange?.(true)
    try {
      await onAlwaysForceDelete()
    } catch (error) {
      toast.error(
        translate('workspaceDeletion.preferenceSaveFailed', 'Could not save deletion preference'),
        { description: error instanceof Error ? error.message : String(error) }
      )
      return
    } finally {
      setIsSaving(false)
      onSavingChange?.(false)
    }
    forceDelete()
  }

  return (
    <DropdownMenu
      modal={false}
      open={menuOpen}
      onOpenChange={(open) => {
        // Why: a hidden toast's chevron still takes keys, but its menu would float over the app.
        if (!open || !isToastHidden()) {
          setMenuOpen(open)
        }
      }}
    >
      <ButtonGroup
        ref={groupRef}
        className={fullWidth ? 'w-full' : undefined}
        onBlur={(event) => {
          if (
            event.relatedTarget instanceof HTMLElement &&
            event.relatedTarget.closest('[data-radix-menu-content]')
          ) {
            event.stopPropagation()
          }
        }}
      >
        <Button
          ref={buttonRef}
          type="button"
          variant="destructive"
          size={size}
          disabled={disabled || isSaving}
          className={fullWidth ? 'min-w-0 flex-1' : undefined}
          onClick={forceDelete}
        >
          {children ??
            translate('auto.components.sidebar.delete.worktree.flow.2b20ce87b3', 'Force Delete')}
        </Button>
        {onAlwaysForceDelete ? (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              size={size === 'sm' ? 'icon-sm' : 'icon'}
              disabled={disabled || isSaving}
              aria-label={
                moreActionsLabel ??
                translate('workspaceDeletion.moreActions', 'More force delete options')
              }
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        ) : null}
      </ButtonGroup>
      {onAlwaysForceDelete ? (
        <DropdownMenuContent
          align="end"
          side={menuSide}
          // Sonner restores toast focus on blur; the portaled menu owns its focus.
          onFocus={(event) => event.stopPropagation()}
          onBlur={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            // Why: focus left on a hidden toast's chevron makes keys act on an invisible control.
            if (isToastHidden()) {
              event.preventDefault()
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  void alwaysForceDelete()
                }}
              >
                {alwaysForceDeleteLabel ??
                  translate('workspaceDeletion.alwaysForceDelete', 'Always force delete')}
              </DropdownMenuItem>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8}>
              {alwaysForceDeleteTooltip ??
                translate(
                  'workspaceDeletion.alwaysForceDeleteTooltip',
                  'Applies to all future workspace deletions.'
                )}
            </TooltipContent>
          </Tooltip>
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  )
}
