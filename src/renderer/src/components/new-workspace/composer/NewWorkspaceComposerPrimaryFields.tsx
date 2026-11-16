import React from 'react'
import { getScreenSubmitModifierLabel } from '@/lib/keyboard/screen-submit-shortcut'
import { NewWorkspaceComposerAgentSection } from './NewWorkspaceComposerAgentSection'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'
import { NewWorkspaceComposerProjectSection } from './NewWorkspaceComposerProjectSection'
import { NewWorkspaceComposerPromptSection } from './NewWorkspaceComposerPromptSection'
import { NewWorkspaceComposerPromptToolbar } from './NewWorkspaceComposerPromptToolbar'
import { NewWorkspaceComposerTargetNotices } from './NewWorkspaceComposerTargetNotices'
import type { NewWorkspaceComposerCardProps } from './new-workspace-composer-card-props'

type NewWorkspaceComposerPrimaryFieldsProps = NewWorkspaceComposerCardProps &
  Omit<React.ComponentProps<typeof NewWorkspaceComposerProjectSection>, 'focusNameInput'> &
  Pick<
    React.ComponentProps<typeof NewWorkspaceComposerAgentSection>,
    'visibleQuickAgents' | 'defaultTuiAgent' | 'handleSetDefaultAgent'
  > &
  Pick<React.ComponentProps<typeof NewWorkspaceComposerNameSection>, 'onNamePlainEnter'> & {
    promptFirst: boolean
    sparseEditing: boolean
    focusNextInput: () => void
  }

/** Project, name and agent fields, either as one prompt box or as the classic stacked form. */
export function NewWorkspaceComposerPrimaryFields({
  promptFirst,
  sparseEditing,
  focusNextInput,
  ...props
}: NewWorkspaceComposerPrimaryFieldsProps): React.JSX.Element {
  const createDisabled = props.createDisabled || sparseEditing
  const nameSection = <NewWorkspaceComposerNameSection {...props} />
  if (promptFirst) {
    return (
      <>
        <NewWorkspaceComposerPromptSection
          {...props}
          createDisabled={createDisabled}
          toolbar={
            <NewWorkspaceComposerPromptToolbar
              {...props}
              disabled={sparseEditing}
              createDisabled={createDisabled}
              focusPromptInput={focusNextInput}
              submitShortcutModifierLabel={getScreenSubmitModifierLabel()}
            />
          }
        />
        <NewWorkspaceComposerTargetNotices {...props} />
        {nameSection}
      </>
    )
  }
  return (
    <>
      <NewWorkspaceComposerProjectSection
        {...props}
        disabled={sparseEditing}
        focusNameInput={focusNextInput}
      />
      {nameSection}
      <NewWorkspaceComposerAgentSection
        {...props}
        createDisabled={createDisabled}
        advancedLocked={sparseEditing}
      />
    </>
  )
}
