import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { AgentLaunchResumeSessionContext } from './agent-launch-resume-session'

const efforts = ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, label: value }))
const claude: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ agent: 'claude', kind: 'terminal' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'opus', label: 'Opus', isDefault: true, efforts },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts },
      { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
    ]
  }
}
const codex: AgentPickerEntry = {
  ...claude,
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'terminal' }],
  catalog: { origin: 'unknown' }
}
const noop = (): void => {}

export const resume = defineFixture({
  width: 960,
  render: () => (
    <div className="h-[440px] bg-background">
      <AgentLaunchResumeSessionContext value={noop}>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger className="m-2">+</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <AgentLaunchPickerMenu entries={[claude, codex]} runLaunch={noop} />
          </DropdownMenuContent>
        </DropdownMenu>
      </AgentLaunchResumeSessionContext>
    </div>
  ),
  interact: async () => {
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Claude"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
