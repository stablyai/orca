import { useState } from 'react'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import { PortalContainerContext } from '../../ui/portal-container-context'
import { AutomationEditorDialog, type AutomationDraft } from './AutomationEditorDialog'

const REPO: Repo = {
  id: 'repo-1',
  path: '/Users/me/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const DRAFT: AutomationDraft = {
  name: 'Weekday repo audit',
  prompt: 'Run the weekly dependency audit and summarize risky changes.',
  agentId: 'claude',
  surface: 'terminal',
  extraAgentArgs: '',
  projectId: REPO.id,
  workspaceMode: 'new_per_run',
  workspaceId: '',
  baseBranch: 'main',
  reuseSession: false,
  precheckCommand: '',
  precheckTimeoutSeconds: '',
  preset: 'weekdays',
  time: '09:00',
  dayOfWeek: '1',
  customSchedule: '',
  savedSchedule: null,
  missedRunGraceMinutes: '',
  scheduleWarning: null,
  bot: null
}

// The dialog is sized from the viewport, so a transformed box stands in for the window and the
// dialog takes the same 2rem inset from it.
function Stage({
  windowWidth,
  draft
}: {
  windowWidth: number
  draft: AutomationDraft
}): React.JSX.Element {
  const [box, setBox] = useState<HTMLElement | null>(null)
  return (
    <div
      ref={setBox}
      className="relative h-[880px] translate-x-0 bg-background [&_[data-slot=dialog-content]]:w-[calc(100%-2rem)] [&_[data-slot=dialog-content]]:max-w-[1080px]"
      style={{ width: windowWidth }}
    >
      {box ? (
        <PortalContainerContext.Provider value={box}>
          <AutomationEditorDialog
            open
            isEditing
            isSaving={false}
            canSave
            repos={[REPO]}
            projectHostSetups={[]}
            automationYamlHooksByRepoKey={{}}
            getAutomationHooksCacheKey={(repoId) => repoId}
            repoMap={new Map([[REPO.id, REPO]])}
            worktrees={[]}
            settings={getDefaultSettings('/tmp')}
            draft={draft}
            bots={[]}
            onProjectChange={() => {}}
            onOpenChange={() => {}}
            onDraftChange={() => {}}
            onSetupDecisionTouched={() => {}}
            onApplyTemplate={() => {}}
            onSave={() => {}}
          />
        </PortalContainerContext.Provider>
      ) : null}
    </div>
  )
}

function editorFixture(windowWidth: number, draft: AutomationDraft = DRAFT) {
  return defineFixture({
    width: windowWidth,
    setup: () => stubBots([]),
    render: () => <Stage windowWidth={windowWidth} draft={draft} />
  })
}

/** A phone-width window: the settings stack under the prompt. */
export const narrow = editorFixture(360)

/** Two columns still fit at a 600px window, so they are kept. */
export const medium = editorFixture(600)

/** A wrapping name and a schedule warning must not squeeze the prompt editor away. */
export const narrowLongName = editorFixture(360, {
  ...DRAFT,
  name: 'Weekday dependency audit across every repository',
  scheduleWarning: 'This schedule was edited outside Orca and will be replaced on save.'
})

/** The default 1080px dialog keeps its two columns. */
export const wide = editorFixture(1112)
