import { Component, type ErrorInfo, type ReactNode } from 'react'

type ArchitectureSectionBoundaryProps = {
  name: string
  resetKey?: string
  children: ReactNode
}

type ArchitectureSectionBoundaryState = {
  error: Error | null
  resetKey?: string
}

export class ArchitectureSectionBoundary extends Component<
  ArchitectureSectionBoundaryProps,
  ArchitectureSectionBoundaryState
> {
  state: ArchitectureSectionBoundaryState = {
    error: null,
    resetKey: this.props.resetKey
  }

  static getDerivedStateFromError(error: Error): ArchitectureSectionBoundaryState {
    return { error }
  }

  static getDerivedStateFromProps(
    props: ArchitectureSectionBoundaryProps,
    state: ArchitectureSectionBoundaryState
  ): Partial<ArchitectureSectionBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[architecture] ${this.props.name} render failed`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children
    }
    return (
      <div
        className="m-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive"
        data-testid="architecture-section-error"
      >
        <div className="font-medium">{this.props.name} could not render</div>
        <div className="mt-1 text-[11px] opacity-80">{this.state.error.message}</div>
      </div>
    )
  }
}
