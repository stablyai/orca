import type React from 'react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import type { GitHistoryProvider } from '../../../../shared/git-history'

const GIT_HISTORY_PROVIDERS: readonly GitHistoryProvider[] = ['auto', 'git', 'jj']

function providerLabel(provider: GitHistoryProvider): string {
  if (provider === 'auto') {
    return 'Auto'
  }
  if (provider === 'git') {
    return 'Git'
  }
  return 'jj'
}

export function GitHistoryProviderSelector({
  value,
  onChange
}: {
  value: GitHistoryProvider
  onChange: (provider: GitHistoryProvider) => void
}): React.JSX.Element {
  return (
    <ButtonGroup className="my-auto ml-1">
      {GIT_HISTORY_PROVIDERS.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant={value === provider ? 'secondary' : 'outline'}
          size="xs"
          className="h-5 px-1.5 text-[10px] font-medium"
          aria-pressed={value === provider}
          onClick={(event) => {
            event.stopPropagation()
            onChange(provider)
          }}
        >
          {providerLabel(provider)}
        </Button>
      ))}
    </ButtonGroup>
  )
}
