import type {
  FindDefinitionsRequest,
  FindDefinitionsResponse,
  SymbolDef
} from '../../../../shared/symbol-index'
import { resolveGoToDefinition } from './resolve-go-to-definition'

export type GoToDefinitionContext = {
  worktreeId: string | null
  worktreeRoot: string | null
  currentPath: string
  currentLine: number
  symbol: string | null
  find: (req: FindDefinitionsRequest) => Promise<FindDefinitionsResponse>
  openAt: (target: SymbolDef) => void
  peek: (targets: SymbolDef[]) => void
  fallback: () => void
}

export async function runGoToDefinition(ctx: GoToDefinitionContext): Promise<void> {
  if (!ctx.symbol || !ctx.worktreeId || !ctx.worktreeRoot) {
    ctx.fallback()
    return
  }
  const response = await ctx.find({
    worktreeId: ctx.worktreeId,
    worktreeRoot: ctx.worktreeRoot,
    symbol: ctx.symbol
  })
  const outcome = resolveGoToDefinition(response, ctx.currentPath, ctx.currentLine)
  if (outcome.kind === 'open') {
    ctx.openAt(outcome.target)
  } else if (outcome.kind === 'peek') {
    ctx.peek(outcome.targets)
  } else {
    ctx.fallback()
  }
}
