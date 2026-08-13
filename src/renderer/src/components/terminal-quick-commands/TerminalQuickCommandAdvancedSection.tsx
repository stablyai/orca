import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Repo, TerminalQuickCommand } from '../../../../shared/types'
import type { getTerminalQuickCommandScope } from '../../../../shared/terminal-quick-commands'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TerminalQuickCommandAppendEnterSwitch } from './TerminalQuickCommandAppendEnterSwitch'
import { TerminalQuickCommandCollapsibleRow } from './TerminalQuickCommandCollapsibleRow'
import { TerminalQuickCommandScopeField } from './TerminalQuickCommandScopeField'

type TerminalQuickCommandAdvancedSectionProps = {
  draft: TerminalQuickCommand
  repos: readonly Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
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

      <TerminalQuickCommandCollapsibleRow open={advancedOpen} className="space-y-4 px-1 pt-2 pb-1">
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
        {!isTerminalAgentQuickCommand(draft) ? (
          <TerminalQuickCommandAppendEnterSwitch
            appendEnter={draft.appendEnter}
            disabled={!advancedOpen}
            onToggle={toggleAppendEnter}
          />
        ) : null}
      </TerminalQuickCommandCollapsibleRow>
    </div>
  )
}
