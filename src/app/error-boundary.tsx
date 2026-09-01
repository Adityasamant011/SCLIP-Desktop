import { Component, type ReactNode, type ErrorInfo } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Clipboard, RefreshCw } from 'lucide-react'
import { createLogger } from '@/shared/logging/logger'
import { i18n } from '@/i18n'
import { copyEditorDiagnosticReport, recordEditorDiagnostic } from '@/infrastructure/editor-diagnostics'

const logger = createLogger('ErrorBoundary')

interface Props {
  children: ReactNode
  fallback?: ReactNode
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  level?: 'app' | 'feature' | 'component'
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    recordEditorDiagnostic('error-boundary', 'error', error.message || 'A React feature crashed', {
      level: this.props.level ?? 'component',
      componentStack: errorInfo.componentStack?.slice(0, 2000),
    })
    // Log to console in development
    if (import.meta.env.DEV) {
      logger.error('ErrorBoundary caught:', error, errorInfo)
    }

    this.props.onError?.(error, errorInfo)
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const { level = 'component' } = this.props

      return (
        <div className="flex flex-col items-center justify-center p-8 gap-4 text-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
          <div>
            <h2 className="text-lg font-semibold">
              {level === 'app' && i18n.t('app.errorBoundary.appError')}
              {level === 'feature' && i18n.t('app.errorBoundary.featureError')}
              {level === 'component' && i18n.t('app.errorBoundary.componentError')}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {this.state.error?.message || i18n.t('app.errorBoundary.unexpectedError')}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={this.handleReset} variant="outline">
              <RefreshCw className="h-4 w-4 mr-2" />
              {i18n.t('app.errorBoundary.tryAgain')}
            </Button>
            {level === 'app' && (
              <Button onClick={() => window.location.reload()}>
                {i18n.t('app.errorBoundary.reloadPage')}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => {
                void copyEditorDiagnosticReport().catch((error) => {
                  recordEditorDiagnostic('diagnostics', 'error', 'Could not copy diagnostic report', {
                    message: error instanceof Error ? error.message : String(error),
                  })
                })
              }}
              title="Copy a safe diagnostic report for support"
            >
              <Clipboard className="h-4 w-4 mr-2" /> Copy report
            </Button>
          </div>
          {import.meta.env.DEV && this.state.error?.stack && (
            <pre className="mt-4 p-4 bg-muted rounded text-xs text-left overflow-auto max-w-full max-h-48">
              {this.state.error.stack}
            </pre>
          )}
        </div>
      )
    }

    return this.props.children
  }
}
