import { defineFixture } from '../../component-fixtures/component-fixture'
import { Input } from '@/components/ui/input'
import { TabAgentSearchHint } from './TabAgentSearchHint'
import { getTabEntryOmniboxPlaceholder } from './tab-create-entry-copy'

export const firstTime = defineFixture({
  width: 320,
  render: () => (
    <div className="bg-background p-4 text-foreground">
      <div className="rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-floating">
        <div className="tab-entry-omnibox relative -mx-1 flex items-center px-3 text-xs text-foreground">
          <Input variant="omnibox" highlighted placeholder={getTabEntryOmniboxPlaceholder()} />
        </div>
        <TabAgentSearchHint
          examples={['Opus (1M context)', '6.1-terra']}
          onDismiss={() => {}}
          onTry={() => {}}
        />
      </div>
    </div>
  ),
  interact: (frame) => frame.querySelector('input')?.focus()
})
