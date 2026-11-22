import type { JSX } from 'react'
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

type OptionChoice<Id extends string> = {
  id: Id
  readonly label: string
  readonly description: string | null
}

/** An options-menu row ("Sort by  Manual ›") whose submenu picks one choice, each described on hover. */
export function OptionChoiceSubmenu<Id extends string>({
  label,
  choices,
  value,
  onChange,
  preserveWorkspaceBoardOpen = false
}: {
  label: string
  choices: readonly OptionChoice<Id>[]
  value: Id
  onChange: (next: Id) => void
  preserveWorkspaceBoardOpen?: boolean
}): JSX.Element {
  const valueLabel = choices.find((choice) => choice.id === value)?.label ?? label
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between">
          <span>{label}</span>
          <span className="text-[11px] font-medium text-muted-foreground">{valueLabel}</span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-44"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            const choice = choices.find((candidate) => candidate.id === next)
            if (choice) {
              onChange(choice.id)
            }
          }}
        >
          {choices.map((choice) => {
            const radioItem = (
              <DropdownMenuRadioItem
                key={choice.id}
                value={choice.id}
                // Keep the menu open for comparing modes and toggling properties.
                onSelect={(e) => e.preventDefault()}
              >
                {choice.label}
              </DropdownMenuRadioItem>
            )
            if (!choice.description) {
              return radioItem
            }
            return (
              <Tooltip key={choice.id}>
                <TooltipTrigger asChild>{radioItem}</TooltipTrigger>
                <TooltipContent side="right" sideOffset={6}>
                  {choice.description}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
