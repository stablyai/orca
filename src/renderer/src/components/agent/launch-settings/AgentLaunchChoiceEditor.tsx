import { useRef, useState, type Ref } from 'react'
import {
  AGENT_LAUNCH_CHOICE_KEYS,
  type AgentModelOptionChoices,
  type AgentChoicePatch
} from '../../../../../shared/agent-launch/choices/agent-launch-choices'
import { AgentDefaultArgsInput } from './AgentLaunchDefaultsEditor'
import { AgentPermissionMenu } from './AgentPermissionMenu'
import type { AgentPermissionChoiceRow } from './agent-permission-choice-row'
import { agentModelChoiceChips } from './agent-model-choice-chips'
import { useAgentLaunchFieldWrite } from './use-agent-launch-field-write'
import { reconcileAgentChoiceArgs } from '../../../../../shared/agent-launch/choices/agent-choice-reconciliation'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { AgentChoiceFields } from './AgentChoiceControls'
import { useAgentSettingsModelCatalog } from './use-agent-settings-model-catalog'

export function AgentLaunchChoiceEditor({
  agent,
  label,
  choices,
  userArgs,
  permission,
  permissionControlRef,
  save,
  catalogTarget,
  showArguments = true
}: {
  showArguments?: boolean
  /** The host whose models this editor lists; null keeps the release's seed models. */
  catalogTarget: RuntimeClientTarget | null
  agent: TuiAgent
  label: string
  choices: AgentModelOptionChoices | undefined
  userArgs: string
  permission: AgentPermissionChoiceRow | undefined
  permissionControlRef?: Ref<HTMLDivElement>
  save: (patch: AgentChoicePatch | undefined, userArgs: string) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const surface = showArguments ? 'terminal' : 'chat'
  const { catalog: liveCatalog, usesSeedModels } = useAgentSettingsModelCatalog(
    agent,
    catalogTarget,
    surface
  )
  const menu = useRef({ open: false, committed: false })
  const editorRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const text = draft ?? userArgs
  const { pending, write } = useAgentLaunchFieldWrite()
  const saveArgs = (raw: string): void => {
    if (raw === userArgs.trim()) {
      setDraft(null)
      return
    }
    write(
      JSON.stringify([null, raw]),
      () => save(undefined, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
  }
  const onOpenChange = (open: boolean): void => {
    if (!open && !menu.current.committed) {
      saveArgs(text.trim())
    }
    menu.current = { open, committed: false }
  }
  const commit = (patch: AgentChoicePatch, raw = text): string => {
    menu.current.committed = true
    const result = reconcileAgentChoiceArgs({
      agent,
      choices: { ...choices, permissionMode: permission?.choice },
      userArgs: raw,
      mode: 'choice-edit',
      keys: AGENT_LAUNCH_CHOICE_KEYS,
      patch
    })
    setDraft(raw)
    write(
      JSON.stringify([patch, raw]),
      () => save(patch, raw),
      () => setDraft((current) => (current === raw ? null : current))
    )
    return result.userArgs
  }
  const chips = agentModelChoiceChips(
    agent,
    label,
    {
      ...choices,
      ...(!permission?.argsSetPermission && permission?.choice
        ? { permissionMode: permission.choice }
        : {})
    },
    commit
  )
  return (
    <div
      ref={editorRef}
      className="space-y-3"
      onBlur={(event) => {
        if (!menu.current.open && !event.currentTarget.contains(event.relatedTarget)) {
          saveArgs(text.trim())
        }
      }}
    >
      <div className="space-y-2">
        <AgentChoiceFields
          agent={agent}
          surface={surface}
          value={choices}
          disabled={pending}
          layout="rows"
          liveCatalog={liveCatalog}
          usesSeedModels={usesSeedModels}
          onOpenChange={onOpenChange}
          optionIds={['effort']}
          onSelect={(patch) => commit(patch)}
        />
        {permission ? (
          <div ref={permissionControlRef}>
            <AgentPermissionMenu
              agentId={agent}
              label={label}
              layout="row"
              disabled={pending}
              onOpenChange={onOpenChange}
              permission={{
                ...permission,
                onSelect: (permissionMode) => commit({ permissionMode })
              }}
            />
          </div>
        ) : null}
      </div>
      {showArguments ? (
        <AgentDefaultArgsInput
          defaultArgs=""
          argsOverride={text}
          disabled={pending}
          onDraftChange={setDraft}
          containsFocus={(target) =>
            menu.current.open ||
            (target instanceof Node && Boolean(editorRef.current?.contains(target)))
          }
          onDiscardArgs={() => setDraft(null)}
          choiceChips={chips}
          note={
            permission?.argsSetPermission
              ? t(
                  'settings.agents.permissionArgsTerminalOnly',
                  'These arguments may control {{agent}}’s terminal permissions, so Orca adds no flag. Chats use the Permissions choice above.',
                  { agent: label }
                )
              : undefined
          }
          onSaveArgs={saveArgs}
        />
      ) : null}
    </div>
  )
}
