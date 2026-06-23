import { useRef, useState } from 'react'
import type {
  Repo,
  TerminalQuickCommand,
  TerminalQuickCommandScope
} from '../../../../shared/types'
import {
  getTerminalQuickCommandAction,
  getTerminalQuickCommandScope,
  isTerminalAgentQuickCommand,
  supportsTerminalAgentQuickCommand
} from '../../../../shared/terminal-quick-commands'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { TuiAgent } from '../../../../shared/types'
import { TerminalQuickCommandActionToggle } from './TerminalQuickCommandActionToggle'
import { TerminalQuickCommandAdvancedSection } from './TerminalQuickCommandAdvancedSection'
import { TerminalQuickCommandContentSection } from './TerminalQuickCommandContentSection'
import { TerminalQuickCommandDialogFooter } from './TerminalQuickCommandDialogFooter'
import { TerminalQuickCommandLabelField } from './TerminalQuickCommandLabelField'
import {
  createTerminalQuickCommandDialogDraftMemory,
  switchTerminalQuickCommandDialogAction
} from './terminal-quick-command-dialog-draft'
import { translate } from '@/i18n/i18n'

type TerminalQuickCommandDialogMode = 'add' | 'edit'

type TerminalQuickCommandDialogProps = {
  open: boolean
  mode: TerminalQuickCommandDialogMode
  command: TerminalQuickCommand
  repos?: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[]
  onOpenChange: (open: boolean) => void
  onSave: (command: TerminalQuickCommand) => void
}

const EMPTY_REPOS: Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'>[] = []

export function createTerminalQuickCommandDraft(
  scope: TerminalQuickCommandScope = { type: 'global' }
): TerminalQuickCommand {
  return {
    id: `quick-command-${createBrowserUuid()}`,
    label: '',
    command: '',
    appendEnter: true,
    scope
  }
}

export function TerminalQuickCommandDialog({
  open,
  mode,
  command,
  repos = EMPTY_REPOS,
  onOpenChange,
  onSave
}: TerminalQuickCommandDialogProps): React.JSX.Element {
  const fallbackAgent: TuiAgent =
    getAgentCatalog().find((entry) => supportsTerminalAgentQuickCommand(entry.id))?.id ?? 'claude'
  const [draft, setDraft] = useState<TerminalQuickCommand>(command)
  const wasOpenRef = useRef(open)
  const syncedCommandRef = useRef(command)
  const draftMemoryRef = useRef(createTerminalQuickCommandDialogDraftMemory(command, fallbackAgent))
  const initialScope = getTerminalQuickCommandScope(command)
  const lastRepoScopeIdRef = useRef<string | null>(
    initialScope.type === 'repo' ? initialScope.repoId : null
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const selectedAction = getTerminalQuickCommandAction(draft)
  const selectedScope = getTerminalQuickCommandScope(draft)
  const isAgentAction = isTerminalAgentQuickCommand(draft)
  const selectedRepo =
    selectedScope.type === 'repo'
      ? (repos.find((repo) => repo.id === selectedScope.repoId) ?? null)
      : null
  const selectedRepoId = selectedRepo?.id ?? ''
  const selectedRepoMissing = selectedScope.type === 'repo' && selectedRepo === null

  if (!open) {
    wasOpenRef.current = false
  } else if (!wasOpenRef.current || syncedCommandRef.current !== command) {
    wasOpenRef.current = true
    syncedCommandRef.current = command
    draftMemoryRef.current = createTerminalQuickCommandDialogDraftMemory(command, fallbackAgent)
    const commandScope = getTerminalQuickCommandScope(command)
    lastRepoScopeIdRef.current = commandScope.type === 'repo' ? commandScope.repoId : null
    setAdvancedOpen(false)
    setDraft({ ...command })
  }

  const selectedAgent =
    isAgentAction && supportsTerminalAgentQuickCommand(draft.agent) ? draft.agent : fallbackAgent

  const setAction = (action: 'terminal-command' | 'agent-prompt'): void => {
    setDraft((current) => {
      const next = switchTerminalQuickCommandDialogAction(current, action, draftMemoryRef.current)
      draftMemoryRef.current = next.memory
      return next.draft
    })
  }

  const toggleAppendEnter = (): void => {
    setDraft((current) =>
      isTerminalAgentQuickCommand(current)
        ? current
        : (() => {
            const appendEnter = !current.appendEnter
            draftMemoryRef.current = {
              ...draftMemoryRef.current,
              terminalAppendEnter: appendEnter
            }
            return { ...current, appendEnter }
          })()
    )
  }

  const saveDraft = (): void => {
    const next: TerminalQuickCommand = isTerminalAgentQuickCommand(draft)
      ? {
          id: draft.id,
          label: draft.label.trim(),
          action: 'agent-prompt',
          agent: draft.agent,
          prompt: draft.prompt.trimEnd(),
          scope: selectedScope
        }
      : {
          id: draft.id,
          label: draft.label.trim(),
          action: 'terminal-command',
          command: draft.command.trimEnd(),
          appendEnter: draft.appendEnter,
          scope: selectedScope
        }
    if (
      !next.label ||
      (isTerminalAgentQuickCommand(next)
        ? !next.prompt.trim() || !supportsTerminalAgentQuickCommand(next.agent)
        : !next.command.trim())
    ) {
      return
    }
    onSave(next)
    onOpenChange(false)
  }

  const canSave =
    draft.label.trim().length > 0 &&
    (isAgentAction
      ? draft.prompt.trimEnd().length > 0 && supportsTerminalAgentQuickCommand(draft.agent)
      : draft.command.trimEnd().length > 0)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {mode === 'edit'
              ? translate(
                  'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.f9b184fc16',
                  'Edit Quick Command'
                )
              : translate(
                  'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.5b3f634a55',
                  'Add Quick Command'
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.ed04233b3e',
              'Save terminal commands or agent prompts for quick access.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div
          className="space-y-4"
          onKeyDown={(event) => {
            if (isScreenSubmitShortcut(event) && canSave) {
              event.preventDefault()
              saveDraft()
            }
          }}
        >
          <TerminalQuickCommandLabelField label={draft.label} setDraft={setDraft} />

          <div className="space-y-2">
            <Label>
              {translate(
                'auto.components.terminal.quick.commands.TerminalQuickCommandDialog.ec8f081919',
                'Action'
              )}
            </Label>
            <TerminalQuickCommandActionToggle
              selectedAction={selectedAction}
              onActionChange={setAction}
            />
          </div>

          <TerminalQuickCommandContentSection
            draft={draft}
            isAgentAction={isAgentAction}
            selectedAgent={selectedAgent}
            draftMemoryRef={draftMemoryRef}
            setDraft={setDraft}
          />

          <TerminalQuickCommandAdvancedSection
            draft={draft}
            repos={repos}
            advancedOpen={advancedOpen}
            selectedScope={selectedScope}
            selectedRepoId={selectedRepoId}
            selectedRepoMissing={selectedRepoMissing}
            lastRepoScopeIdRef={lastRepoScopeIdRef}
            setAdvancedOpen={setAdvancedOpen}
            setDraft={setDraft}
            toggleAppendEnter={toggleAppendEnter}
          />
        </div>

        <TerminalQuickCommandDialogFooter
          canSave={canSave}
          submitShortcutLabel={submitShortcutLabel}
          onCancel={() => onOpenChange(false)}
          onSave={saveDraft}
        />
      </DialogContent>
    </Dialog>
  )
}
