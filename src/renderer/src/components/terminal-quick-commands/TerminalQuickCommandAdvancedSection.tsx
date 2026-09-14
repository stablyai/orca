import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TerminalQuickCommandScopeField } from './TerminalQuickCommandScopeField'

type TerminalQuickCommandAdvancedSectionProps = {
  repos: readonly Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  advancedOpen: boolean
  selectedScope: ReturnType<typeof getTerminalQuickCommandScope>
  selectedRepo: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'> | null
  selectedRepoId: string
  selectedRepoMissing: boolean
  lastRepoScopeIdRef: MutableRefObject<string | null>
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
}

function getScopeSummaryLabel({
  selectedScope,
  selectedRepo
}: {
  selectedScope: ReturnType<typeof getTerminalQuickCommandScope>
  selectedRepo: Pick<Repo, 'displayName' | 'path'> | null
}): string {
  if (selectedScope.type === 'global') {
    return translate(
      'auto.components.terminal.quick.commands.TerminalQuickCommandScopeField.b83efc79e2',
      'Global'
    )
  }
  if (selectedRepo) {
    return selectedRepo.displayName || selectedRepo.path
  }
  return translate(
    'auto.components.terminal.quick.commands.TerminalQuickCommandScopeField.3834d24243',
    'Project'
  )
}

export function TerminalQuickCommandAdvancedSection({
  repos,
  advancedOpen,
  selectedScope,
  selectedRepo,
  selectedRepoId,
  selectedRepoMissing,
  lastRepoScopeIdRef,
  setAdvancedOpen,
  setDraft
}: TerminalQuickCommandAdvancedSectionProps): React.JSX.Element {
  const scopeSummary = getScopeSummaryLabel({ selectedScope, selectedRepo })

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setAdvancedOpen((current) => !current)}
        className="-ml-2 max-w-full min-w-0 text-xs"
        aria-expanded={advancedOpen}
      >
        <span className="shrink-0">
          {translate(
            'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.925b8e0f6e',
            'Advanced'
          )}
        </span>
        {/* Why: a repo display name or path can be arbitrarily long; truncate instead of widening the toggle. */}
        {!advancedOpen ? (
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            · {scopeSummary}
          </span>
        ) : null}
        <ChevronDown className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')} />
      </Button>

      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!advancedOpen}
        inert={!advancedOpen}
      >
        <div className="min-h-0">
          <div
            className={cn(
              'space-y-4 px-1 pt-1 pb-1 transition-[opacity,transform] duration-150 ease-out',
              advancedOpen
                ? 'translate-y-0 opacity-100 delay-200'
                : '-translate-y-1 opacity-0 delay-0'
            )}
          >
            <TerminalQuickCommandScopeField
              repos={repos}
              selectedScope={selectedScope}
              selectedRepoId={selectedRepoId}
              selectedRepoMissing={selectedRepoMissing}
              lastRepoScopeId={lastRepoScopeIdRef.current}
              rememberRepoScopeId={(repoId) => {
                lastRepoScopeIdRef.current = repoId
              }}
              setDraft={setDraft}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
