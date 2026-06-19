import { ChevronDown, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { GiteaMergeMethod } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

const MERGE_METHODS: GiteaMergeMethod[] = ['merge', 'squash', 'rebase']

type GiteaPrMergeButtonProps = {
  mergeable: boolean | undefined
  merging: boolean
  onMerge: (method: GiteaMergeMethod) => void
}

export function GiteaPrMergeButton({
  mergeable,
  merging,
  onMerge
}: GiteaPrMergeButtonProps): React.JSX.Element {
  return (
    <div className="ml-auto">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" disabled={merging || mergeable === false} className="gap-1">
            {merging ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
            {mergeable === false
              ? translate('auto.components.gitea.pr.merge.button.2378ab4908', 'Conflicts')
              : translate('auto.components.gitea.pr.merge.button.8e662b9b6b', 'Merge')}
            <ChevronDown className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-40 p-1">
          {MERGE_METHODS.map((method) => (
            <button
              key={method}
              type="button"
              onClick={() => onMerge(method)}
              className="flex w-full items-center rounded-sm px-2 py-1.5 text-left text-[12px] capitalize hover:bg-accent"
            >
              {method}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  )
}
