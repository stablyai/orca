import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SandboxOnlyBrowserPageState } from './sandbox-only-browser-page-state'

function Pane({ url, error = false }: { url: string; error?: boolean }): React.JSX.Element {
  return (
    <div className="flex h-[420px] w-[720px] flex-col bg-background text-foreground">
      <div className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">
        {url}
      </div>
      <SandboxOnlyBrowserPageState
        url={url}
        opening={false}
        error={error}
        onOpenOnThisComputer={() => {}}
      />
    </div>
  )
}

export const http = defineFixture({ width: 740, render: () => <Pane url="https://example.org/" /> })
/** Desktop-hosted cloud pages tunnel loopback through the sandbox, so this opens the sandbox's server. */
export const localhost = defineFixture({
  width: 740,
  render: () => <Pane url="http://localhost:3000/dashboard" />
})
export const nonHttp = defineFixture({
  width: 740,
  render: () => <Pane url="file:///tmp/report.html" />
})
export const openFailed = defineFixture({
  width: 740,
  render: () => <Pane url="https://example.org/" error />
})
