import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { TabGroupResizeHandle } from '../tab-group/TabGroupSplitLayout'

function SplitNode({
  node,
  path,
  renderPane,
  onRatioChange
}: {
  node: TabGroupLayoutNode
  path: string[]
  renderPane: (paneId: string) => React.ReactNode
  onRatioChange: (path: string[], ratio: number) => void
}): React.JSX.Element {
  if (node.type === 'leaf') {
    return <div className="flex flex-1 min-h-0 min-w-0 p-1.5">{renderPane(node.groupId)}</div>
  }
  const horizontal = node.direction === 'horizontal'
  const ratio = node.ratio ?? 0.5
  return (
    <div
      className="flex flex-1 min-h-0 min-w-0 overflow-hidden"
      style={{ flexDirection: horizontal ? 'row' : 'column' }}
    >
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${ratio} 1 0%` }}>
        <SplitNode
          node={node.first}
          path={[...path, 'first']}
          renderPane={renderPane}
          onRatioChange={onRatioChange}
        />
      </div>
      <TabGroupResizeHandle
        direction={node.direction}
        onResizeStart={() => {}}
        onRatioChange={(nextRatio) => onRatioChange(path, nextRatio)}
      />
      <div className="flex min-h-0 min-w-0 overflow-hidden" style={{ flex: `${1 - ratio} 1 0%` }}>
        <SplitNode
          node={node.second}
          path={[...path, 'second']}
          renderPane={renderPane}
          onRatioChange={onRatioChange}
        />
      </div>
    </div>
  )
}

export function WorkspaceMultiplexerSplitLayout({
  layout,
  expandedPaneId,
  renderPane,
  onRatioChange
}: {
  layout: TabGroupLayoutNode
  expandedPaneId: string | null
  renderPane: (paneId: string) => React.ReactNode
  onRatioChange: (path: string[], ratio: number) => void
}): React.JSX.Element {
  return expandedPaneId ? (
    <div className="flex flex-1 min-h-0 min-w-0 p-1.5">{renderPane(expandedPaneId)}</div>
  ) : (
    <SplitNode node={layout} path={[]} renderPane={renderPane} onRatioChange={onRatioChange} />
  )
}
