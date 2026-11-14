import { StrictMode, useRef, useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getAgentCatalog, type AgentCatalogEntry } from '@/lib/agent-catalog/agent-catalog'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'
import { Button } from '../../../ui/button'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { SettingsSwitchRow } from '../../form-controls/SettingsFormControls'
import { scrollSubsectionIntoView } from '../../navigation/settings-navigation-foundations'
import { getSettingsTitleTargetId } from '../../section-layout/settings-target-highlight'

function AgentLists({ short = false }: { short?: boolean }): React.JSX.Element {
  const catalog = getAgentCatalog()
  const [installed, setInstalled] = useState(
    () => new Set(catalog.slice(0, short ? 1 : 12).map((agent) => agent.id))
  )
  const [command, setCommand] = useState<string>()
  const [deferSave, setDeferSave] = useState(false)
  const complete = useRef<(() => void) | null>(null)
  const shown = short ? catalog.slice(0, 2) : catalog
  const moving = shown[0]
  const rowProps = (agent: AgentCatalogEntry, detected: boolean) => ({
    agentId: agent.id,
    label: agent.label,
    homepageUrl: agent.homepageUrl,
    defaultCmd: agent.cmd,
    defaultArgs: '',
    defaultEnv: {},
    isDetected: agent === moving ? false : detected,
    isEnabled: true,
    defaultMark: null,
    isSavedDefault: false,
    cmdOverride: agent === moving ? command : undefined,
    argsOverride: '',
    envOverride: {},
    opensAs:
      agent === moving
        ? { value: 'chat' as const, cliMissing: false, onChange: () => {} }
        : undefined,
    permissionChoice:
      agent === moving
        ? {
            choice: 'own' as const,
            defaultChoice: 'full-access' as const,
            choices: ['own', 'full-access'] as const,
            source: 'agent' as const,
            flag: '',
            argsSetPermission: false,
            onSelect: () => {}
          }
        : undefined,
    onSetDefault: () => {},
    onSetEnabled: () => {},
    onSaveOverride: async (value: string) => {
      if (deferSave) {
        await new Promise<void>((resolve) => {
          complete.current = resolve
        })
      }
      if (agent === moving) {
        setCommand(value)
      }
    },
    onSaveArgs: () => {},
    onSaveEnv: () => {}
  })
  return (
    <StrictMode>
      <div className="settings-view-shell space-y-4">
        <div className="flex flex-wrap gap-2" data-fixture-controls="">
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              setTimeout(() => {
                setInstalled((previous) => {
                  const next = new Set(previous)
                  if (!next.delete(moving.id)) {
                    next.add(moving.id)
                  }
                  return next
                })
              }, 0)
            }
          >
            Move first agent
          </Button>
          <Button variant="outline" size="xs" onClick={() => setDeferSave(!deferSave)}>
            Defer saves: {String(deferSave)}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              complete.current?.()
              complete.current = null
            }}
          >
            Finish save
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() =>
              scrollSubsectionIntoView(
                getSettingsTitleTargetId(shown.at(-1)!.label),
                document.querySelector('[data-fixture-settings-page]')
              )
            }
          >
            Jump to last agent
          </Button>
        </div>
        <div data-fixture-settings-page="" className="scrollbar-sleek h-[900px] overflow-auto p-8">
          <div className="mx-auto max-w-[720px] space-y-8">
            <h2 className="text-xl font-semibold">Agents</h2>
            <AgentDetectionCatalog
              detectedAgents={shown.filter((agent) => installed.has(agent.id))}
              undetectedAgents={shown.filter((agent) => !installed.has(agent.id))}
              detectionPending={false}
              detectionFailed={false}
              isRefreshing={false}
              activeServerEnvironmentId={null}
              activeServerName={null}
              onRefresh={() => {}}
              getRowProps={rowProps}
            />
            <SettingsGroup title="Codex history">
              <SettingsSwitchRow
                label="Share history with Codex"
                description="Use past chats as context"
                checked
                onChange={() => {}}
              />
            </SettingsGroup>
            <SettingsGroup title="This computer">
              <SettingsSwitchRow label="Agent status hooks" checked onChange={() => {}} />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </StrictMode>
  )
}

export const overflowing = defineFixture({ width: 860, render: () => <AgentLists /> })
export const fitting = defineFixture({ width: 860, render: () => <AgentLists short /> })
export const narrow = defineFixture({ width: 440, render: () => <AgentLists /> })
