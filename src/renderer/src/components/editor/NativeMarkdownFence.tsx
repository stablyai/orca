import type { ReactNode } from 'react'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import { NativeMarkdownOutput } from './NativeMarkdownOutput'
import { useNativeMarkdownOutput } from './use-native-markdown-output'

export function NativeMarkdownFence({
  language,
  code,
  children,
  className
}: {
  language: string
  code: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  const { context, output } = useNativeMarkdownOutput(language, code)
  return (
    <>
      {!output || output.kind === 'error' ? (
        <CodeBlockCopyButton>
          <code className={className}>{children}</code>
        </CodeBlockCopyButton>
      ) : null}
      {context && output ? <NativeMarkdownOutput context={context} output={output} /> : null}
    </>
  )
}
