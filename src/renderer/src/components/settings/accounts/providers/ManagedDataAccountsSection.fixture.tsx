import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ManagedDataAccountsSection } from './ManagedDataAccountsSection'

function Frame(): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <ManagedDataAccountsSection provider="opencode" target={{ kind: 'local' }} />
    </div>
  )
}

/** The CLI steps start hidden behind "Use from the command line". */
export const cliCollapsed = defineFixture({ width: 720, render: () => <Frame /> })

export const cliOpen = defineFixture({
  width: 720,
  render: () => <Frame />,
  interact: async (frame) => {
    const trigger = [...frame.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Use from the command line')
    )
    trigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
