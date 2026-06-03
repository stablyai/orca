import type { Dispatch, SetStateAction } from 'react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { QUICK_COMMAND_TOGGLE_ITEM_CLASS } from './terminal-quick-command-toggle-style'

type TerminalQuickCommandScopeFieldProps = {
  repos: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  selectedScope: TerminalQuickCommandScope
  selectedRepoId: string
  selectedRepoMissing: boolean
  lastRepoScopeId: string | null
  rememberRepoScopeId: (repoId: string) => void
  setDraft: Dispatch<SetStateAction<TerminalQuickCommand>>
}

function getRepoLabel(repo: Pick<Repo, 'displayName' | 'path'>): string {
  return repo.displayName || repo.path
}

export function getQuickCommandProjectScopeRepoId(
  repos: Pick<Repo, 'id'>[],
  lastRepoScopeId: string | null
): string | null {
  return lastRepoScopeId ?? repos[0]?.id ?? null
}

export function TerminalQuickCommandScopeField({
  repos,
  selectedScope,
  selectedRepoId,
  selectedRepoMissing,
  lastRepoScopeId,
  rememberRepoScopeId,
  setDraft
}: TerminalQuickCommandScopeFieldProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label>Scope</Label>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={selectedScope.type}
          onValueChange={(value) => {
            if (value === 'global') {
              setDraft((current) => ({ ...current, scope: { type: 'global' } }))
            }
            if (value === 'repo' && selectedScope.type !== 'repo') {
              const repoId = getQuickCommandProjectScopeRepoId(repos, lastRepoScopeId)
              if (!repoId) {
                return
              }
              // Why: toggling Global should not discard the command's project
              // and silently move it to whichever repo is first in the list.
              rememberRepoScopeId(repoId)
              setDraft((current) => ({
                ...current,
                scope: { type: 'repo', repoId }
              }))
            }
          }}
          className="justify-start"
          variant="outline"
        >
          <ToggleGroupItem value="global" className={QUICK_COMMAND_TOGGLE_ITEM_CLASS}>
            Global
          </ToggleGroupItem>
          <ToggleGroupItem
            value="repo"
            disabled={repos.length === 0}
            className={QUICK_COMMAND_TOGGLE_ITEM_CLASS}
          >
            Project
          </ToggleGroupItem>
        </ToggleGroup>
        {selectedScope.type === 'repo' && repos.length > 0 ? (
          <div className="space-y-1">
            <Select
              value={selectedRepoId}
              onValueChange={(repoId) => {
                rememberRepoScopeId(repoId)
                setDraft((current) => ({ ...current, scope: { type: 'repo', repoId } }))
              }}
            >
              <SelectTrigger size="sm" className="min-w-48">
                <SelectValue
                  placeholder={selectedRepoMissing ? 'Project not in list' : 'Choose project'}
                />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.id} value={repo.id}>
                    <RepoBadgeLabel
                      name={getRepoLabel(repo)}
                      color={repo.badgeColor}
                      className="max-w-full"
                    />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRepoMissing ? (
              <p className="max-w-48 text-xs text-muted-foreground">
                Saving keeps the existing project scope unless you choose another.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
