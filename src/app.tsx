import { Suspense, lazy, useEffect, useState } from 'react'
import { RouterProvider, createRouter, createHashHistory } from '@tanstack/react-router'
import { GlobalTooltip } from '@/components/ui/global-tooltip'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ErrorBoundary } from '@/app/error-boundary'
import { PwaInstallPrompt } from '@/app/pwa-install-prompt'
import { RouteErrorScreen } from '@/app/route-error'
import { WorkspaceGate } from '@/features/workspace-gate/workspace-gate'
import { RenderQueueRunner } from '@/features/export/components/render-queue-runner'
import { routeTree } from './routeTree.gen'

import { initMcpBridge } from '@/infrastructure/sclip-mcp-bridge'
import { installAutomaticCorrectionCapture } from '@/infrastructure/automatic-correction-capture'

// Initialize MCP bridge eagerly
if (typeof window !== 'undefined') {
  installAutomaticCorrectionCapture()
  initMcpBridge().catch(console.error)
}

// Route errors (thrown from beforeLoad/loader) never reach the React
// ErrorBoundary below — TanStack catches them first. Without this, they render
// its untranslated built-in fallback with the message hidden in production.
const router = createRouter({ routeTree, defaultErrorComponent: RouteErrorScreen, history: createHashHistory() })
const LazyToaster = lazy(async () => {
  const { Toaster } = await import('@/components/ui/sonner')
  return { default: Toaster }
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

export function App() {
  const [showToaster, setShowToaster] = useState(false)

  // Ensure MCP Bridge is attached when React mounts
  useEffect(() => {
    initMcpBridge().catch((err) => console.error('[App] initMcpBridge error:', err))
  }, [])

  // Prevent default browser zoom application-wide
  useEffect(() => {
    const wheelListenerOptions: AddEventListenerOptions = { passive: false, capture: true }
    const keyListenerOptions: AddEventListenerOptions = { capture: true }

    const preventBrowserZoom = (e: WheelEvent) => {
      // Prevent browser zoom when Ctrl/Cmd is held
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
      }
    }

    const preventKeyboardZoom = (e: KeyboardEvent) => {
      // Prevent browser zoom shortcuts: Ctrl+=/+/-, Ctrl+0
      // Only preventDefault (blocks browser zoom), event still propagates to react-hotkeys-hook
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0') {
          e.preventDefault()
          // DO NOT call stopPropagation() - we want react-hotkeys-hook to still receive this
        }
      }
    }

    // Add listeners at capture phase to intercept before browser handles them
    document.addEventListener('wheel', preventBrowserZoom, wheelListenerOptions)
    document.addEventListener('keydown', preventKeyboardZoom, keyListenerOptions)

    return () => {
      document.removeEventListener('wheel', preventBrowserZoom, wheelListenerOptions)
      document.removeEventListener('keydown', preventKeyboardZoom, keyListenerOptions)
    }
  }, [])

  useEffect(() => {
    const show = () => setShowToaster(true)
    window.addEventListener('freecut:ensure-toaster', show)
    return () => {
      window.removeEventListener('freecut:ensure-toaster', show)
    }
  }, [])

  // TooltipProvider is required for Radix tooltip consumers across editor surfaces.
  // GlobalTooltip handles lightweight data-tooltip attributes without per-item providers.
  // Toaster for toast notifications
  // ErrorBoundary for graceful error recovery
  // WorkspaceGate blocks RouterProvider until a workspace handle is granted.
  // Mounted HERE (not inside __root.tsx) so route loaders — which run before
  // children components mount — never see an uninitialized workspace root.
  return (
    <ErrorBoundary level="app">
      <TooltipProvider delayDuration={300}>
        <WorkspaceGate>
          <RouterProvider router={router} />
          <RenderQueueRunner />
        </WorkspaceGate>
        <GlobalTooltip />
        <PwaInstallPrompt />
        {showToaster && (
          <Suspense fallback={null}>
            <LazyToaster />
          </Suspense>
        )}
      </TooltipProvider>
    </ErrorBoundary>
  )
}
