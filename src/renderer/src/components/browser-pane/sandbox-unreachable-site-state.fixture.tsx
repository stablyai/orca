import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  describeSandboxUnreachableSite,
  SandboxUnreachableSiteState
} from './sandbox-unreachable-site-state'

function Pane({ url }: { url: string }): React.JSX.Element {
  const site = describeSandboxUnreachableSite({ code: -120, validatedUrl: url }, url)!
  return (
    <div className="flex h-[420px] w-[720px] flex-col bg-background text-foreground">
      <div className="border-b border-border px-3 py-2 font-mono text-xs text-muted-foreground">
        {url}
      </div>
      <div className="relative flex-1">
        <SandboxUnreachableSiteState
          site={site}
          errorName="ERR_SOCKS_CONNECTION_FAILED"
          onOpenInBrowser={() => {}}
          onRetry={() => {}}
          isActive={false}
          sandboxAwake
        />
      </div>
    </div>
  )
}

export const outsideSite = defineFixture({
  width: 740,
  render: () => <Pane url="https://example.com/" />
})
export const sandboxServerNotRunning = defineFixture({
  width: 740,
  render: () => <Pane url="http://localhost:3000/" />
})
