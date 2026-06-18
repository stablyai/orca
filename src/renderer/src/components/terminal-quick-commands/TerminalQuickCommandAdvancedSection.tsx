import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Repo, TerminalQuickCommand } from '../../../../shared/types'
import type { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TerminalQuickCommandAppendEnterSwitch } from './TerminalQuickCommandAppendEnterSwitch'
import { TerminalQuickCommandScopeField } from './TerminalQuickCommandScopeField'

type TerminalQuickCommandAdvancedSectionProps = {
  draft: TerminalQuickCommand
  repos: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  advancedOpen: boolean
  selectedScope: ReturnType<typeof getTerminalQuickCommandScope>
  selectedRepoId: string
  selectedRepoMissing: boolean
  lastRepoScopeIdRef: MutableRefObject<string | null>
  setAdvancedOpen: Dispatch<SetStateAction<boolean>>
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
  toggleAppendEnter: () => void
}

export function TerminalQuickCommandAdvancedSection({
  draft,
  repos,
  advancedOpen,
  selectedScope,
  selectedRepoId,
  selectedRepoMissing,
  lastRepoScopeIdRef,
  setAdvancedOpen,
  setDraft,
  toggleAppendEnter
}: TerminalQuickCommandAdvancedSectionProps): React.JSX.Element {
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setAdvancedOpen((current) => !current)}
        className="-ml-2 text-xs"
      >
        {translate(
          'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.925b8e0f6e',
          'Advanced'
        )}
        <ChevronDown className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')} />
      </Button>

      <div
        className={cn(
          'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
          advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!advancedOpen}
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
            {!isTerminalAgentQuickCommand(draft) ? (
              <TerminalQuickCommandAppendEnterSwitch
                appendEnter={draft.appendEnter}
                onToggle={toggleAppendEnter}
              />
            ) : null}
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
