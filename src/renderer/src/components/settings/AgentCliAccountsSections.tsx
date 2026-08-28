import { AgentIcon } from '@/lib/agent-catalog'
import { Button } from '@/components/ui/button'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import {
  getAccountsAntigravitySearchEntries,
  getAccountsKimiSearchEntries
} from './accounts-search'

type Props = { searchQuery: string; onOpenAgents: () => void }

export function AgentCliAccountsSections({
  searchQuery,
  onOpenAgents
}: Props): React.JSX.Element[] {
  const sections: React.JSX.Element[] = []
  if (matchesSettingsSearch(searchQuery, getAccountsKimiSearchEntries())) {
    sections.push(
      <section key="kimi" id="accounts-kimi" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="kimi" size={16} />
            Kimi
          </h3>
          <p className="text-xs text-muted-foreground">
            Use the Kimi CLI login for sessions launched by Orca.
          </p>
        </div>
        <SearchableSetting
          title="System default"
          description="Kimi authentication stays in the local Kimi CLI configuration. Orca does not copy or expose the credential."
          keywords={['kimi', 'account', 'cli', 'login', 'auth']}
          className="flex items-center justify-between gap-4 py-2"
        >
          <Button type="button" variant="outline" size="sm" onClick={onOpenAgents}>
            Open Agents settings
          </Button>
        </SearchableSetting>
      </section>
    )
  }
  if (matchesSettingsSearch(searchQuery, getAccountsAntigravitySearchEntries())) {
    sections.push(
      <section key="antigravity" id="accounts-antigravity" className="space-y-4 scroll-mt-6">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AgentIcon agent="antigravity" size={16} />
            Antigravity
          </h3>
          <p className="text-xs text-muted-foreground">
            Use the Antigravity CLI login for sessions launched by Orca.
          </p>
        </div>
        <SearchableSetting
          title="System default"
          description="Antigravity authentication stays in the local Gemini/Antigravity CLI configuration. Orca does not copy or expose the credential."
          keywords={['antigravity', 'gemini', 'account', 'cli', 'login', 'auth']}
          className="flex items-center justify-between gap-4 py-2"
        >
          <Button type="button" variant="outline" size="sm" onClick={onOpenAgents}>
            Open Agents settings
          </Button>
        </SearchableSetting>
      </section>
    )
  }
  return sections
}
