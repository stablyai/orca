import React, { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Switch } from '@/components/ui/switch'
import { discoverSkillsForRuntimeTarget } from '@/runtime/runtime-skills-client'
import type { DiscoveredSkill } from '../../../../../shared/skills'
import {
  WORKFLOW_TOOLS,
  type WorkflowAgentNode,
  type WorkflowTool
} from '../../../../../shared/workflow/workflow-definition-schema'
import { useWorkflowEditorStore } from '../workflow-editor-store'
import { InspectorNote, InspectorSection, SelectField } from './workflow-inspector-fields'
import { useUpdateAgentProfile } from './use-workflow-node'
import { translate } from '@/i18n/i18n'

const TOOL_LABEL: Record<WorkflowTool, string> = {
  terminal: 'Terminal',
  files: 'File access',
  git: 'Git',
  browser: 'Browser',
  mcp: 'MCP servers',
  tests: 'Test runner'
}

function useInstalledSkills(): { skills: DiscoveredSkill[] | null; error: string | null } {
  const [state, setState] = useState<{ skills: DiscoveredSkill[] | null; error: string | null }>({
    skills: null,
    error: null
  })
  useEffect(() => {
    let cancelled = false
    discoverSkillsForRuntimeTarget({ kind: 'local' })
      .then((result) => !cancelled && setState({ skills: result.skills, error: null }))
      .catch(
        (error: unknown) =>
          !cancelled &&
          setState({ skills: [], error: error instanceof Error ? error.message : String(error) })
      )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

export function AgentSkillsSection({ node }: { node: WorkflowAgentNode }): React.JSX.Element {
  const update = useUpdateAgentProfile(node.id)
  const checkpoint = useWorkflowEditorStore((state) => state.checkpoint)
  const readOnly = useWorkflowEditorStore((state) => state.mode === 'execution')
  const { skills, error } = useInstalledSkills()
  const [open, setOpen] = useState(false)
  const byName = useMemo(
    () => new Map((skills ?? []).map((skill) => [skill.name, skill])),
    [skills]
  )
  const attached = node.agent.skills
  const available = (skills ?? []).filter(
    (skill) => !attached.some((entry) => entry.name === skill.name)
  )

  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.AgentSkillsToolsSections.23b04ffcba',
        'Skills'
      )}
      defaultOpen={attached.length > 0}
    >
      {attached.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.workflows.inspector.AgentSkillsToolsSections.de8139b9cc',
            'No skills attached.'
          )}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {attached.map((skill) => {
          const found = byName.get(skill.name)
          return (
            <li
              key={skill.name}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs">{skill.name}</div>
                <div className="truncate text-2xs text-muted-foreground">
                  {skills === null
                    ? translate(
                        'auto.components.workflows.inspector.AgentSkillsToolsSections.e5a3b783cc',
                        'Checking…'
                      )
                    : found
                      ? `${found.sourceLabel} · ${found.providers.join(', ')}`
                      : translate(
                          'auto.components.workflows.inspector.AgentSkillsToolsSections.08437e0cda',
                          'Not installed on this computer'
                        )}
                </div>
              </div>
              <label className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                {translate(
                  'auto.components.workflows.inspector.AgentSkillsToolsSections.bebff77830',
                  'Required'
                )}
                <Switch
                  checked={skill.required}
                  disabled={readOnly}
                  onCheckedChange={(required) => {
                    checkpoint()
                    update((agent) => {
                      agent.skills = agent.skills.map((entry) =>
                        entry.name === skill.name ? { ...entry, required } : entry
                      )
                    })
                  }}
                />
              </label>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.workflows.inspector.AgentSkillsToolsSections.77bffc7486',
                  'Remove {{value0}}',
                  { value0: skill.name }
                )}
                disabled={readOnly}
                onClick={() => {
                  checkpoint()
                  update((agent) => {
                    agent.skills = agent.skills.filter((entry) => entry.name !== skill.name)
                  })
                }}
              >
                <X />
              </Button>
            </li>
          )
        })}
      </ul>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={readOnly || skills === null}>
            {skills === null ? <Loader2 className="animate-spin" /> : <Plus />}
            {translate(
              'auto.components.workflows.inspector.AgentSkillsToolsSections.9310f46f58',
              'Attach skill'
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <Command>
            <CommandInput
              placeholder={translate(
                'auto.components.workflows.inspector.AgentSkillsToolsSections.34e4b34d91',
                'Search installed skills'
              )}
            />
            <CommandList>
              <CommandEmpty>
                {error
                  ? translate(
                      'auto.components.workflows.inspector.AgentSkillsToolsSections.a790ee94d8',
                      'Discovery failed: {{value0}}',
                      { value0: error }
                    )
                  : translate(
                      'auto.components.workflows.inspector.AgentSkillsToolsSections.12c799bd43',
                      'No more installed skills.'
                    )}
              </CommandEmpty>
              {available.map((skill) => (
                <CommandItem
                  key={skill.id}
                  value={`${skill.name} ${skill.description ?? ''}`}
                  onSelect={() => {
                    checkpoint()
                    update((agent) => {
                      agent.skills = [...agent.skills, { name: skill.name, required: false }]
                    })
                    setOpen(false)
                  }}
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs">{skill.name}</div>
                    {skill.description ? (
                      <div className="line-clamp-2 text-2xs text-muted-foreground">
                        {skill.description}
                      </div>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <InspectorNote>
        {translate(
          'auto.components.workflows.inspector.AgentSkillsToolsSections.bddaf507d2',
          'Agents load skills from their own skill directories. Orca verifies a skill is installed on the execution host and names it in the prompt; it cannot hide other installed skills from the agent. Required skills block launch when missing.'
        )}
      </InspectorNote>
    </InspectorSection>
  )
}

type ToolMode = 'expected' | 'avoid' | 'unspecified'

export function AgentToolsSection({ node }: { node: WorkflowAgentNode }): React.JSX.Element {
  const update = useUpdateAgentProfile(node.id)
  return (
    <InspectorSection
      title={translate(
        'auto.components.workflows.inspector.AgentSkillsToolsSections.d35a5138cc',
        'Tools and permissions'
      )}
      defaultOpen={node.agent.tools.length > 0}
    >
      {WORKFLOW_TOOLS.map((tool) => {
        const current = node.agent.tools.find((entry) => entry.tool === tool)?.mode ?? 'unspecified'
        return (
          <SelectField<ToolMode>
            key={tool}
            label={TOOL_LABEL[tool]}
            value={current}
            options={[
              {
                value: 'unspecified',
                label: translate(
                  'auto.components.workflows.inspector.AgentSkillsToolsSections.7b9cf07027',
                  'Not mentioned'
                )
              },
              {
                value: 'expected',
                label: translate(
                  'auto.components.workflows.inspector.AgentSkillsToolsSections.b2487881f9',
                  'Expected to use'
                )
              },
              {
                value: 'avoid',
                label: translate(
                  'auto.components.workflows.inspector.AgentSkillsToolsSections.8a3a601f86',
                  'Told not to use'
                )
              }
            ]}
            onChange={(mode) =>
              update((agent) => {
                const rest = agent.tools.filter((entry) => entry.tool !== tool)
                agent.tools = mode === 'unspecified' ? rest : [...rest, { tool, mode }]
              })
            }
          />
        )
      })}
      <InspectorNote tone="warning">
        {translate(
          'auto.components.workflows.inspector.AgentSkillsToolsSections.17a62c685e',
          'These are declared to the agent, not enforced. The agent CLI keeps its own permission settings; a prompt cannot sandbox a shell. Orca enforces only message routes, workspace placement, timeouts and budgets.'
        )}
      </InspectorNote>
    </InspectorSection>
  )
}
