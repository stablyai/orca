import { Handle, Position } from '@xyflow/react'

const hiddenStyle = { opacity: 0, pointerEvents: 'none' as const }

const handles = [
  { id: 'top', position: Position.Top, style: undefined },
  { id: 'bottom', position: Position.Bottom, style: undefined },
  { id: 'left', position: Position.Left, style: undefined },
  { id: 'right', position: Position.Right, style: undefined },
  { id: 'top-left', position: Position.Top, style: { left: 0 } },
  { id: 'top-right', position: Position.Top, style: { left: '100%' } },
  { id: 'bottom-left', position: Position.Bottom, style: { left: 0 } },
  { id: 'bottom-right', position: Position.Bottom, style: { left: '100%' } }
]

export function NodeHandles({ hidden }: { hidden?: boolean }): React.JSX.Element {
  return (
    <>
      {handles.flatMap((handle) => {
        const style = hidden ? { ...hiddenStyle, ...handle.style } : handle.style
        return [
          <Handle
            key={`source-${handle.id}`}
            type="source"
            position={handle.position}
            id={handle.id}
            isConnectable={!hidden}
            style={style}
          />,
          <Handle
            key={`target-${handle.id}`}
            type="target"
            position={handle.position}
            id={handle.id}
            isConnectable={!hidden}
            style={style}
          />
        ]
      })}
    </>
  )
}
